// Extension discovery in a world file, in Node: buildWowScene finds the nodes that carry
// `webofworlds_extension.universal_extensions`, checks each declaration against the strict
// `UniversalExtensionDeclaration` schema, and keeps a visible marker for every refused one. Nothing is fetched or run
// here; the mount pass (web/wow-extension-mount.mjs) does that, and src/wow-extension-mount-browser-check.mjs checks it.
//
// The manifest-* cases run the mount pass in Node on a node that points to a signed carrier manifest
// (`webofworlds_extension.universal_extension_manifests`), with a recording fetch in place of a test server (every
// request the pass makes goes through it) and a loadExtension that only records what it is given. hidden-page-pauses
// runs the mount pass with the real extension host (worker_threads) and a document stand-in whose visibility it sets.
//
// Lazy start (quiet discovery, Lab packet QD-1): the mount pass starts nothing at world load; an extension starts when
// the visitor selects its glance (mounted.select). The cases that run an extension select it first. The lazy-*,
// select-* and no-rank cases check the rule itself.
//
// The place (web/wow-extension-place-store.mjs): a world names a store of module copies and a withdrawn list on its own
// origin. The place-*, no-copy-*, advance-fetch-* and status-list-* cases mount the place world
// (src/fixtures/extension-host/world/place-world.json) with a recording fetch; the maker and the issuer are origins the
// recording fetch sees, so a request to either is caught. A carrier's status comes from the withdrawn list only: the
// manifest-*-refused and manifest-status-* cases read it there, and check that no status address is ever asked.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { buildWowScene, validateExtensionDeclaration, EXTENSION_DECLARATION_MEMBERS } from "../web/wow-scene.mjs";
import { mountWowExtensions } from "../web/wow-extension-mount.mjs";
import { createGrantStore, placementKeyOf, renderExtensionsPanel } from "../web/wow-extension-consent.mjs";
import { integrityOf, loadExtension as hostLoadExtension } from "../runtime/extension-host/extension-host.mjs";
import { UE_TEST_MODULES } from "./fixtures/extension-host/test-modules.mjs";
import { verifyManifestProfileA } from "../web/signing/um-signature-profile-a.mjs";
import { parseIJson } from "../web/signing/ijson.mjs";
import { carrierManifest, newCarrierKey } from "./fixtures/extension-host/carrier.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const { check, finish } = nodeChecks("wow-extension-discovery");
const code = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const WORLD = JSON.parse(await readFile(code("src/fixtures/extension-host/world/extension-world.json"), "utf8"));
const SCHEMA = yaml.load(await readFile(code("wow-spec/schema.yaml"), "utf8"));
const TEST_NODES = ["rp1-stool", "ue-box", "bad-hash", "wants-panel", "runaway"];

const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A one-root world with the given children nodes (ids from 1). */
function world(children) {
  return {
    spatialID: "extension-discovery",
    root: 0,
    nodes: [{ id: 0, label: "root", children: children.map((_, i) => i + 1), localTransform: IDENTITY },
      ...children.map((node, i) => ({ id: i + 1, parent: 0, localTransform: IDENTITY, ...node }))],
  };
}
const goodDeclaration = () => JSON.parse(JSON.stringify(WORLD.nodes.find((node) => node.label === "ue-box").webofworlds_extension.universal_extensions[0]));
const objectsUnder = (group) => {
  const found = [];
  group.traverse((object) => found.push(object));
  return found;
};

await check("ext-discover", "The five test nodes are extension nodes, and none is an asset node or a fabric node", () => {
  const built = buildWowScene(WORLD, THREE, { source: "check" });
  const labels = built.extension_nodes.map((node) => node.label);
  assert(same([...labels].sort(), [...TEST_NODES].sort()), `extension_nodes are ${JSON.stringify(labels)}`);
  const ids = new Set(built.extension_nodes.map((node) => node.node_id));
  const asAsset = built.asset_nodes.filter((node) => ids.has(node.id)).map((node) => node.label);
  assert(asAsset.length === 0, `extension nodes in asset_nodes: ${asAsset.join(", ")}`);
  const asFabric = built.fabric_nodes.filter((node) => ids.has(node.node_id)).map((node) => node.label);
  assert(asFabric.length === 0, `extension nodes in fabric_nodes: ${asFabric.join(", ")}`);
  for (const node of built.extension_nodes) {
    assert(node.group && node.group.name === `wow:${node.label}`, `${node.label} carries no node group`);
    assert(Array.isArray(node.declarations) && node.declarations.length === node.validations.length, `${node.label} declarations and validations differ`);
  }
  const summary = built.render_summary.extensions;
  assert(summary && summary.extension_nodes === 5 && summary.declarations === 5, `render_summary.extensions is ${JSON.stringify(summary && { nodes: summary.extension_nodes, declarations: summary.declarations })}`);
  assert(/never sniffed/.test(summary.discriminator), "the summary does not state the discriminator");
});

await check("ext-no-suffix-sniff", "A node whose spatialAssetURI ends in .wasm, without the labeled member, is not an extension node", () => {
  const built = buildWowScene(world([{ label: "wasm-address", spatialAssetURI: "modules/box-maker.wasm" }]), THREE, { source: "check" });
  assert(built.extension_nodes.length === 0, `a .wasm address made ${built.extension_nodes.length} extension node(s)`);
  assert(built.render_summary.extensions === undefined, "a world with no labeled member has render_summary.extensions");
  assert(built.asset_nodes.length === 1, "the .wasm address is not kept as the asset address it is");
});

await check("ext-declaration-refused", "A declaration without module.integrity is refused at stage declaration, keeps a marker and is counted", () => {
  const declaration = goodDeclaration();
  delete declaration.module.integrity;
  const built = buildWowScene(world([{ label: "no-hash", webofworlds_extension: { universal_extensions: [declaration] } }]), THREE, { source: "check" });
  const [node] = built.extension_nodes;
  assert(node, "the node is not an extension node");
  const [validation] = node.validations;
  assert(validation && validation.ok === false, "a declaration without module.integrity is accepted");
  assert(validation.stage === "declaration", `refused at stage ${validation.stage}`);
  const marker = objectsUnder(node.group).find((object) => object.userData && object.userData.ueStage === "declaration");
  assert(marker, "no marker for the refused declaration under the node group");
  assert(/^ue-refused:declaration:/.test(marker.name), `the marker is named ${marker.name}`);
  const summary = built.render_summary.extensions;
  assert(summary.refused === 1 && summary.valid === 0, `render_summary.extensions counts refused ${summary.refused}, valid ${summary.valid}`);
  assert(summary.refusals.length === 1 && summary.refusals[0].stage === "declaration", "the refusal is not listed with its stage");
});

await check("ext-schema-strict", "An unknown member is refused, and EXTENSION_DECLARATION_MEMBERS equals the schema's properties", () => {
  const declaration = { ...goodDeclaration(), autoGrant: true };
  const refused = validateExtensionDeclaration(declaration);
  assert(refused.ok === false && refused.reason === "UNKNOWN_MEMBER", `an unknown member gives ${JSON.stringify(refused)}`);
  const accepted = validateExtensionDeclaration(goodDeclaration());
  assert(accepted.ok === true, `the test world's declaration is refused: ${JSON.stringify(accepted)}`);
  const schemas = SCHEMA.components.schemas;
  const schema = schemas.UniversalExtensionDeclaration;
  assert(schema && schema["x-osl-extension"] === true, "UniversalExtensionDeclaration is missing or not labeled x-osl-extension");
  assert(schema.additionalProperties === false, "UniversalExtensionDeclaration is not strict");
  const members = Object.keys(schema.properties);
  assert(same([...EXTENSION_DECLARATION_MEMBERS].sort(), [...members].sort()),
    `EXTENSION_DECLARATION_MEMBERS ${JSON.stringify(EXTENSION_DECLARATION_MEMBERS)} is not the schema's ${JSON.stringify(members)}`);
  const carried = schemas.WebOfWorldsExtension.properties.universal_extensions;
  assert(carried && carried.type === "array" && carried.items && carried.items.$ref === "#/components/schemas/UniversalExtensionDeclaration",
    "WebOfWorldsExtension.universal_extensions is not an array of UniversalExtensionDeclaration");
  const { getValidator } = require("../wow-spec/validate.js");
  const validator = getValidator();
  const good = validator.validate("UniversalExtensionDeclaration", goodDeclaration());
  assert(good.valid, `the schema refuses the test world's declaration: ${good.errorsText}`);
  assert(validator.validate("UniversalExtensionDeclaration", declaration).valid === false, "the schema accepts an unknown member");
});

// ---- Extensions declared by signed carrier manifests ----
// A byte copy of docs/universal-extensions/fixtures/carrier-without-profile.json (PROVENANCE.md gives its SHA-256).
const FIXTURE = code("src/fixtures/extension-host/carrier-without-profile.json");
const BOX = await readFile(code("src/fixtures/extension-host/world/box-maker.wasm"));
const BOX_MODULE = { url: "../box-maker.wasm", integrity: "sha256-J+MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk=", binding: "ue-core/0" };
const LAB = "http://lab.test";
const CARRIER_WORLD = `${LAB}/worlds/carrier-world.json`;
const CARRIER_URL = `${LAB}/worlds/carriers/carrier.json`;
const MODULE_URL = `${LAB}/worlds/box-maker.wasm`;
const LIST_URL = `${LAB}/worlds/withdrawn.json`;
const KEY_A = newCarrierKey(), KEY_B = newCarrierKey();
const STORAGE_REQUEST = { capability: "ue.storage.local", purpose: "keep the box's notes" };
const carrierOf = (extra = {}) => carrierManifest({ key: KEY_A, module: BOX_MODULE, attach: { kind: "world-node", anchor: "1" },
  requests: [{ capability: "ue.scene.nodes", purpose: "draw the box" }], ...extra });

/**
 * Mounts a one-node world whose node points to the carrier `text` (null: the carrier answers 404); returns the record,
 * the requests and the loads. `answers` maps further URLs (a status endpoint, or the carrier itself) to { status, body },
 * or to { never: true } for an address that never answers (until its abort signal, if it has one, is aborted).
 * `fetchLimitMs` is the adapter's time limit for one fetch. `extension` adds members to the extension the stand-in
 * loadExtension gives. `signals` maps each requested URL to the abort signal its fetch was given.
 */
async function mountCarrier(text, { grantStore, answers = {}, fetchLimitMs, extension = {}, list } = {}) {
  const seen = [], loads = [], signals = new Map();
  // `list`: the place's withdrawn list, as an answer ({ status, body } or { never: true }); undefined for none.
  if (list !== undefined) answers = { ...answers, [LIST_URL]: list };
  const files = { ...(text === null ? {} : { [CARRIER_URL]: text }), [MODULE_URL]: BOX };
  const recordingFetch = async (url, init = {}) => {
    seen.push(String(url));
    if (init && init.signal) signals.set(String(url), init.signal);
    if (Object.hasOwn(answers, String(url)) && answers[String(url)].never) {
      return new Promise((_, reject) => { if (init && init.signal) init.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
    }
    if (Object.hasOwn(answers, String(url))) return new Response(JSON.stringify(answers[String(url)].body ?? null), { status: answers[String(url)].status });
    return Object.hasOwn(files, String(url)) ? new Response(files[String(url)]) : new Response("not found", { status: 404 });
  };
  const loadExtension = async (args) => {
    loads.push(args);
    return { ok: true, running: true, nodes: [], shutdown: async () => {}, setGrant: async () => {}, ...extension };
  };
  const scene = world([{ label: "carried", webofworlds_extension: { universal_extension_manifests: [{ url: "carriers/carrier.json" }] } }]);
  if (list !== undefined) scene.webofworlds_extension = { extension_status_list: { url: "withdrawn.json" } };
  const built = buildWowScene(scene, THREE, { source: "check" });
  const mounted = await mountWowExtensions(built.extension_nodes, THREE, { loadExtension, worldUrl: CARRIER_WORLD, pageOrigin: LAB, fetch: recordingFetch, ...(grantStore ? { grantStore } : {}), ...(fetchLimitMs ? { fetchLimitMs } : {}) });
  const record = mounted.records.find((item) => item.label === "carried") || null;
  // The visitor selects the extension's glance: only then is its module fetched.
  if (record && record.status === "not-started" && typeof mounted.select === "function") await mounted.select(record);
  const status = record ? record.status : null;
  const marker = record && record.marker ? { name: record.marker.name, stage: record.marker.userData.ueStage, under: objectsUnder(built.extension_nodes[0].group).includes(record.marker) } : null;
  await mounted.unmount();
  const modules = seen.filter((url) => url === MODULE_URL).length;
  const state = record ? `status ${status}, stage ${record.stage}` : "no record";
  return { built, mounted, record, status, marker, seen, signals, loads, modules, says: `${state}; module requests ${modules}; loads ${loads.length}` };
}
const refusedAt = (run, stage) => run.status === "refused" && run.record.stage === stage && run.modules === 0 && run.loads.length === 0;

await check("manifest-fixture-verifies", "The Lab verifier accepts the carrier-without-profile.json fixture unchanged", async () => {
  const report = await verifyManifestProfileA(parseIJson(await readFile(FIXTURE, "utf8")));
  assert(report.ok === true, `the fixture does not verify: ${JSON.stringify(report)}`);
});

await check("manifest-tampered-refused", "One changed character in the facet's module.integrity is refused at signature, and no module is requested", async () => {
  const text = JSON.stringify(carrierOf());
  const tampered = text.replace("sha256-J+ME", "sha256-K+ME");
  assert(tampered !== text, "the test could not change module.integrity");
  const valid = await mountCarrier(text);
  assert(valid.status === "mounted", `the untampered carrier does not run: ${valid.says} (${valid.record && valid.record.error})`);
  const run = await mountCarrier(tampered);
  assert(refusedAt(run, "signature"), `the tampered carrier: ${run.says}`);
  const { marker } = run;
  assert(marker && marker.under && marker.stage === "signature" && marker.name === "ue-refused:signature:carried#0", `no ue-refused:signature:carried#0 marker under the node: ${JSON.stringify(marker)}`);
});

await check("manifest-unsigned-refused", "A carrier with no signature member is refused at signature", async () => {
  const run = await mountCarrier(JSON.stringify(carrierManifest({ key: null, module: BOX_MODULE, attach: { kind: "world-node", anchor: "1" }, requests: [] })));
  assert(refusedAt(run, "signature"), `the unsigned carrier: ${run.says}`);
});

await check("manifest-expired-refused", "A correctly signed carrier whose expiresAt is in the past is refused at validity", async () => {
  const run = await mountCarrier(JSON.stringify(carrierOf({ issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2021-01-01T00:00:00.000Z" })));
  assert(refusedAt(run, "validity"), `the expired carrier: ${run.says}`);
});

await check("manifest-anchor-mismatch", "attach.anchor naming another node is refused at facet", async () => {
  const run = await mountCarrier(JSON.stringify(carrierOf({ attach: { kind: "world-node", anchor: "2" } })));
  assert(refusedAt(run, "facet"), `the carrier anchored to node 2: ${run.says}`);
});

await check("manifest-placement-key", "A grant holds for the same carrier reissued with new @ids; the same module under another key asks again", async () => {
  const grantStore = createGrantStore({ storage: null });
  const requests = [STORAGE_REQUEST];
  const first = await mountCarrier(JSON.stringify(carrierOf({ requests })), { grantStore });
  assert(first.status === "mounted" && first.record.needs_consent.includes("ue.storage.local"), `the first carrier: ${first.says}, needs ${JSON.stringify(first.record && first.record.needs_consent)}`);
  grantStore.grant(first.record.placement_key, first.record.validation.effective, ["ue.storage.local"]);
  const reissued = await mountCarrier(JSON.stringify(carrierOf({ requests, id: "urn:uuid:check-carrier-2", facetId: "urn:osl:check:facet:2" })), { grantStore });
  assert(reissued.record && reissued.record.grant.includes("ue.storage.local") && reissued.record.needs_consent.length === 0,
    `the reissued carrier asks again: ${reissued.says}, grant ${JSON.stringify(reissued.record && reissued.record.grant)}`);
  const otherKey = await mountCarrier(JSON.stringify(carrierOf({ requests, key: KEY_B })), { grantStore });
  assert(otherKey.status === "mounted" && !otherKey.record.grant.includes("ue.storage.local") && otherKey.record.needs_consent.includes("ue.storage.local"),
    `the same module under another key is granted without asking: ${otherKey.says}, grant ${JSON.stringify(otherKey.record && otherKey.record.grant)}`);
});

// ---- Refusals at each stage of a carrier (OI-23) and an integrity algorithm the host does not implement ----
const detailOf = (run) => (run.record && run.record.error) || "";

await check("manifest-fetch-refused", "A carrier that fails to download (HTTP 404) is refused at manifest-fetch, with a marker, and no module is requested", async () => {
  const run = await mountCarrier(null);
  assert(refusedAt(run, "manifest-fetch"), `the missing carrier: ${run.says}`);
  assert(/HTTP 404/.test(detailOf(run)), `the refusal does not give the HTTP status: ${JSON.stringify(detailOf(run))}`);
  assert(run.marker && run.marker.under && run.marker.stage === "manifest-fetch", `no manifest-fetch marker under the node: ${JSON.stringify(run.marker)}`);
});

await check("manifest-not-yet-valid", "A correctly signed carrier whose issuedAt is in the future is refused at validity", async () => {
  const run = await mountCarrier(JSON.stringify(carrierOf({ issuedAt: "2099-01-01T00:00:00.000Z", expiresAt: "2100-01-01T00:00:00.000Z" })));
  assert(refusedAt(run, "validity"), `the carrier issued in 2099: ${run.says}`);
  assert(/not yet valid/.test(detailOf(run)), `the refusal does not say not yet valid: ${JSON.stringify(detailOf(run))}`);
});

await check("manifest-unknown-attach-kind", "A facet whose attach.kind is not a known kind is refused at facet", async () => {
  const run = await mountCarrier(JSON.stringify(carrierOf({ attach: { kind: "hologram", anchor: "1" } })));
  assert(refusedAt(run, "facet"), `the carrier with attach.kind hologram: ${run.says}`);
  assert(/attach\.kind/.test(detailOf(run)), `the refusal does not name attach.kind: ${JSON.stringify(detailOf(run))}`);
});

await check("manifest-request-without-purpose", "A request with no purpose refuses the whole extension at facet, its other requests too", async () => {
  const run = await mountCarrier(JSON.stringify(carrierOf({ requests: [{ capability: "ue.scene.nodes", purpose: "draw the box" }, { capability: "ue.console.log" }] })));
  assert(refusedAt(run, "facet"), `the carrier with a request without purpose: ${run.says}`);
  assert(/no purpose/.test(detailOf(run)), `the refusal does not say which request has no purpose: ${JSON.stringify(detailOf(run))}`);
});

await check("manifest-sha384-refused", "A carrier whose module.integrity is sha384- is refused, with a reason that names sha384", async () => {
  const sha384 = { ...BOX_MODULE, integrity: `sha384-${"A".repeat(64)}` };
  const run = await mountCarrier(JSON.stringify(carrierOf({ module: sha384 })));
  assert(refusedAt(run, "facet"), `the sha384 carrier: ${run.says}`);
  assert(/sha384/.test(detailOf(run)), `the refusal does not name the algorithm: ${JSON.stringify(detailOf(run))}`);
});

// ---- The extension's status: from the place's withdrawn list only; its signed entity.statusRef is never fetched ----
const STATUS_URL = "https://status.test/manifests/check-carrier-1";
const statusAnswer = (status) => ({ [STATUS_URL]: { status: 200, body: { manifestId: "urn:uuid:check-carrier-1", status, updatedAt: "2026-11-17T00:00:00.000Z" } } });
const withStatus = () => JSON.stringify(carrierOf({ statusRef: STATUS_URL }));
const askedStatus = (run) => run.seen.includes(STATUS_URL);
/** The place's withdrawn list as an answer: `status` for check-carrier-1, or no entry for it. */
const listed = (status, id = "urn:uuid:check-carrier-1") => ({ status: 200, body: { checkedAt: "2026-11-23T00:00:00Z", entries: status ? [{ "@id": id, status }] : [{ "@id": "urn:uuid:another-carrier", status: "revoked" }] } });

await check("manifest-revoked-refused", "A carrier the place's withdrawn list names as revoked is refused at status, with no module and no request to its status address", async () => {
  const run = await mountCarrier(withStatus(), { list: listed("revoked"), answers: statusAnswer("active") });
  assert(refusedAt(run, "status"), `the revoked carrier: ${run.says}`);
  assert(/revoked/.test(detailOf(run)), `the refusal does not say revoked: ${JSON.stringify(detailOf(run))}`);
  assert(run.marker && run.marker.under && run.marker.stage === "status", `no status marker under the node: ${JSON.stringify(run.marker)}`);
  assert(!askedStatus(run), "the revoked carrier's status address was asked");
  const active = await mountCarrier(withStatus(), { list: listed(null), answers: statusAnswer("revoked") });
  assert(active.status === "mounted" && !askedStatus(active), `the carrier the list does not name: ${active.says}; status asked ${askedStatus(active)} (${active.record && active.record.error})`);
});

await check("manifest-suspended-refused", "A carrier the place's withdrawn list names as suspended is refused at status, and no module is requested", async () => {
  const run = await mountCarrier(withStatus(), { list: listed("suspended") });
  assert(refusedAt(run, "status"), `the suspended carrier: ${run.says}`);
  assert(/suspended/.test(detailOf(run)), `the refusal does not say suspended: ${JSON.stringify(detailOf(run))}`);
  assert(!askedStatus(run), "the suspended carrier's status address was asked");
});

await check("manifest-status-unchecked-runs", "A carrier runs as unchecked, with the reason, when the withdrawn list does not load and when the world has none; its status address is not asked", async () => {
  const run = await mountCarrier(withStatus(), { list: { status: 503 } });
  const carrier = (run.record && run.record.carrier) || {};
  assert(run.status === "mounted" && !askedStatus(run), `the carrier whose list did not load: ${run.says}; status asked ${askedStatus(run)} (${run.record && run.record.error})`);
  assert(carrier.revocationStatus === "unchecked", `the carrier whose list did not load: the record says ${JSON.stringify(carrier.revocationStatus)}, not unchecked`);
  assert(/did not load/.test(carrier.revocationReason || ""), `the unchecked record gives no reason: ${JSON.stringify(carrier.revocationReason)}`);
  const plain = await mountCarrier(withStatus());
  const plainCarrier = (plain.record && plain.record.carrier) || {};
  assert(plain.status === "mounted" && plainCarrier.revocationStatus === "unchecked" && !askedStatus(plain), `the carrier in a world with no list: ${plain.says}, revocationStatus ${JSON.stringify(plainCarrier.revocationStatus)}, status asked ${askedStatus(plain)}`);
  assert(/no withdrawn list/.test(plainCarrier.revocationReason || ""), `the record of a world with no list gives no reason: ${JSON.stringify(plainCarrier.revocationReason)}`);
});


// ---- The status address is signed (entity.statusRef); an unsigned one is never used; fetches have a time limit ----
await check("manifest-status-signed", "A carrier with a signed entity.statusRef, with or without a matching signature.statusRef, runs and its address is never asked; listed revoked, it is refused at status", async () => {
  const signedOnly = await mountCarrier(JSON.stringify(carrierOf({ statusRef: STATUS_URL })), { list: listed(null), answers: statusAnswer("revoked") });
  assert(signedOnly.status === "mounted" && !askedStatus(signedOnly), `the carrier with only entity.statusRef: ${signedOnly.says}; status asked ${askedStatus(signedOnly)} (${detailOf(signedOnly)})`);
  assert(signedOnly.record.carrier.status_ref === STATUS_URL, `the record does not keep the signed address: ${JSON.stringify(signedOnly.record.carrier.status_ref)}`);
  const both = await mountCarrier(JSON.stringify(carrierOf({ statusRef: STATUS_URL, signatureStatusRef: STATUS_URL })), { list: listed(null), answers: statusAnswer("revoked") });
  assert(both.status === "mounted" && !askedStatus(both), `the carrier with a matching signature.statusRef: ${both.says}; status asked ${askedStatus(both)} (${detailOf(both)})`);
  const bothListed = await mountCarrier(JSON.stringify(carrierOf({ statusRef: STATUS_URL, signatureStatusRef: STATUS_URL })), { list: listed("revoked") });
  assert(refusedAt(bothListed, "status") && /revoked/.test(detailOf(bothListed)) && !askedStatus(bothListed), `the listed carrier with a matching signature.statusRef: ${bothListed.says} (${detailOf(bothListed)})`);
});

const OTHER_STATUS_URL = "https://elsewhere.test/manifests/check-carrier-1";
await check("manifest-status-stripped", "A signature.statusRef that differs from entity.statusRef, or stands alone, is refused at status", async () => {
  const answers = { ...statusAnswer("revoked"), [OTHER_STATUS_URL]: statusAnswer("active")[STATUS_URL] };
  const redirected = await mountCarrier(JSON.stringify(carrierOf({ statusRef: STATUS_URL, signatureStatusRef: OTHER_STATUS_URL })), { answers });
  assert(refusedAt(redirected, "status"), `the carrier whose signature.statusRef was redirected: ${redirected.says}`);
  assert(/signature\.statusRef/.test(detailOf(redirected)), `the refusal does not name signature.statusRef: ${JSON.stringify(detailOf(redirected))}`);
  const unsigned = await mountCarrier(JSON.stringify(carrierOf({ signatureStatusRef: OTHER_STATUS_URL })), { answers });
  assert(refusedAt(unsigned, "status"), `the carrier with only an unsigned signature.statusRef: ${unsigned.says}`);
  assert(!unsigned.seen.includes(OTHER_STATUS_URL), "the unsigned status address was requested");
});

const GUARD_MS = 3000, LIMIT_MS = 200;
/** run() or a FAIL message when it gives no answer within GUARD_MS. */
async function guarded(what, run) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(null), GUARD_MS); });
  const value = await Promise.race([run(), guard]);
  clearTimeout(timer);
  assert(value, `${what}: no answer after ${GUARD_MS} ms`);
  return value;
}
await check("manifest-status-timeout", "A withdrawn list that never answers gives unchecked within the time limit, and the extension runs; a carrier that never answers is refused at manifest-fetch", async () => {
  const started = Date.now();
  const run = await guarded("the carrier whose withdrawn list never answers", () => mountCarrier(withStatus(), { list: { never: true }, fetchLimitMs: LIMIT_MS }));
  const carrier = (run.record && run.record.carrier) || {};
  assert(run.status === "mounted" && run.seen.includes(LIST_URL) && !askedStatus(run) && carrier.revocationStatus === "unchecked",
    `the carrier whose withdrawn list never answers: ${run.says}; list asked ${run.seen.includes(LIST_URL)}; status asked ${askedStatus(run)}; revocationStatus ${JSON.stringify(carrier.revocationStatus)}`);
  assert(Date.now() - started < GUARD_MS, `the mount took ${Date.now() - started} ms`);
  const hung = await guarded("the carrier that never answers", () => mountCarrier(null, { answers: { [CARRIER_URL]: { never: true } }, fetchLimitMs: LIMIT_MS }));
  assert(refusedAt(hung, "manifest-fetch") && /within/.test(detailOf(hung)), `the carrier that never answers: ${hung.says} (${detailOf(hung)})`);
});

/** A small DOM stand-in: elements with tag, attributes, children and textContent only (no markup parser). */
function stubDocument() {
  const make = (tag) => ({
    tag, attrs: {}, children: [], textContent: "",
    setAttribute(name, value) { this.attrs[name] = String(value); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren() { this.children = []; },
    addEventListener() {}, remove() {},
  });
  return { createElement: make };
}
const allUnder = (node) => node.children.flatMap((child) => [child, ...allUnder(child)]);
await check("status-not-checked-line", "The Extensions panel shows \"status not checked\", as plain text, for an unchecked carrier extension", async () => {
  const run = await mountCarrier(JSON.stringify(carrierOf()));
  assert(run.status === "mounted" && run.record.carrier && run.record.carrier.revocationStatus === "unchecked", `the carrier without statusRef: ${run.says}`);
  const { element } = renderExtensionsPanel({ document: stubDocument(), mounted: run.mounted });
  const row = allUnder(element).find((node) => node.attrs["data-ue-extension"] === `${run.record.label}#${run.record.index}`);
  assert(row, "the panel has no row for the carrier extension");
  const lines = allUnder(row).filter((node) => node.textContent === "status not checked");
  assert(lines.length === 1, `the panel row has ${lines.length} "status not checked" line(s)`);
  assert(lines[0].children.length === 0 && lines[0].attrs["data-ue-revocation"] === "unchecked", `the line is not plain text: ${lines[0].children.length} child element(s)`);
});

// ---- Time budgets on the page: a hidden page delivers nothing, cancelled fetches, the "slow" line ----
await check("fetch-aborted", "A carrier fetch and a withdrawn-list fetch that never answer are aborted at the time limit: each fetch sees its signal aborted", async () => {
  const list = await guarded("the carrier whose withdrawn list never answers", () => mountCarrier(withStatus(), { list: { never: true }, fetchLimitMs: LIMIT_MS }));
  const listSignal = list.signals.get(LIST_URL);
  assert(listSignal, "the withdrawn-list fetch was given no abort signal");
  assert(listSignal.aborted, "the withdrawn-list fetch's signal was not aborted at the time limit");
  const carrier = await guarded("the carrier that never answers", () => mountCarrier(null, { answers: { [CARRIER_URL]: { never: true } }, fetchLimitMs: LIMIT_MS }));
  const carrierSignal = carrier.signals.get(CARRIER_URL);
  assert(carrierSignal, "the carrier fetch was given no abort signal");
  assert(carrierSignal.aborted, "the carrier fetch's signal was not aborted at the time limit");
});

await check("slow-line", "The Extensions panel shows \"slow\" with the count of overruns, as plain text, for an extension with overruns", async () => {
  const run = await mountCarrier(JSON.stringify(carrierOf()), { extension: { overruns: 3 } });
  assert(run.status === "mounted", `the carrier: ${run.says}`);
  const { element } = renderExtensionsPanel({ document: stubDocument(), mounted: run.mounted });
  const row = allUnder(element).find((node) => node.attrs["data-ue-extension"] === `${run.record.label}#${run.record.index}`);
  assert(row, "the panel has no row for the extension");
  const lines = allUnder(row).filter((node) => /^slow\b/.test(node.textContent));
  assert(lines.length === 1, `the panel row has ${lines.length} "slow" line(s)`);
  assert(/\b3\b/.test(lines[0].textContent), `the "slow" line does not give the count 3: ${JSON.stringify(lines[0].textContent)}`);
  assert(lines[0].children.length === 0 && lines[0].attrs["data-ue-slow"] === "3", `the line is not plain text with data-ue-slow="3": ${JSON.stringify(lines[0].attrs)}`);
  const quiet = await mountCarrier(JSON.stringify(carrierOf()), { extension: { overruns: 0 } });
  const { element: quietPanel } = renderExtensionsPanel({ document: stubDocument(), mounted: quiet.mounted });
  assert(!allUnder(quietPanel).some((node) => /^slow\b/.test(node.textContent)), "an extension without overruns is shown as slow");
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A document stand-in for visibility: visibilityState, visibilitychange listeners, and elements without a canvas. */
function visibilityDocument() {
  const listeners = new Set();
  const doc = {
    visibilityState: "visible",
    createElement: () => ({ getContext: () => null }),
    addEventListener(type, listener) { if (type === "visibilitychange") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "visibilitychange") listeners.delete(listener); },
    show(state) {
      doc.visibilityState = state;
      for (const listener of [...listeners]) listener();
    },
  };
  return doc;
}
await check("hidden-page-pauses", "While the page is hidden no timer or pointer event reaches an extension; when it is visible again the timer that came due fires once", async () => {
  const PERIOD_MS = 150;
  const bytes = UE_TEST_MODULES.ueTimerNode({ delayMs: PERIOD_MS });
  const declaration = {
    module: { url: "timer-node.wasm", integrity: await integrityOf(bytes), binding: "ue-core/0" }, interface: "ue:host@0.2.0", attach: { kind: "world-node" },
    requests: ["ue.console.log", "ue.scene.nodes", "ue.clock.timer", "ue.input.pointer"], purposes: { "ue.input.pointer": "reacts to a click on its box" }, limits: {},
  };
  const worldUrl = `${LAB}/worlds/hidden-world.json`;
  const built = buildWowScene(world([{ label: "timer-node", webofworlds_extension: { universal_extensions: [declaration] } }]), THREE, { source: "check" });
  const effective = built.extension_nodes[0].validations[0].effective;
  assert(effective, `the declaration is refused: ${JSON.stringify(built.extension_nodes[0].validations[0])}`);
  const grantStore = createGrantStore({ storage: null });
  grantStore.grant(placementKeyOf({ world: worldUrl, node: "1", integrity: effective.module.integrity, attach: effective.attach }), effective, ["ue.input.pointer"]);
  const doc = visibilityDocument();
  const fetch = async (url) => (String(url) === `${LAB}/worlds/timer-node.wasm` ? new Response(bytes) : new Response("not found", { status: 404 }));
  const mounted = await mountWowExtensions(built.extension_nodes, THREE, { loadExtension: hostLoadExtension, worldUrl, pageOrigin: LAB, fetch, document: doc, grantStore });
  const record = mounted.records[0];
  if (record.status === "not-started" && typeof mounted.select === "function") await mounted.select(record);
  try {
    assert(record.status === "mounted", `the timer node: status ${record.status} at ${record.stage}: ${record.error}`);
    const extension = record.extension;
    const count = (type) => extension.events.filter((item) => item.event && item.event.type === type).length;
    const object = [...record.objects.values()][0];
    assert(object, "the extension made no node");
    for (let at = 0; at < 40 && count("timer") < 1; at += 1) await sleep(50);
    assert(count("timer") >= 1, "no timer event reached the extension on the visible page");
    assert(mounted.pointer({ object, type: "click", point: [0, 0, 0] }) === true, "a click on the visible page was not sent");
    for (let at = 0; at < 20 && count("pointer") < 1; at += 1) await sleep(50);
    assert(count("pointer") === 1, `the click on the visible page reached the extension ${count("pointer")} time(s)`);
    doc.show("hidden");
    await sleep(30);
    const timers = count("timer"), pointers = count("pointer");
    const sent = mounted.pointer({ object, type: "click", point: [0, 0, 0] });
    await sleep(5 * PERIOD_MS);
    const timersHidden = count("timer") - timers, pointersHidden = count("pointer") - pointers;
    doc.show("visible");
    await sleep(40);
    const atOnce = count("timer") - timers - timersHidden;
    assert(timersHidden === 0 && pointersHidden === 0 && !sent, `while hidden: ${timersHidden} timer and ${pointersHidden} pointer event(s) reached the extension (click sent: ${sent})`);
    assert(atOnce >= 1 && atOnce <= 2, `on visible, the timer that came due 5 times fired ${atOnce} time(s) at once, not once`);
    assert(extension.running, `the extension is not running: ${extension.error}`);
  } finally {
    await mounted.unmount();
  }
});

// ---- Quiet discovery: glances first, nothing fetched for an extension until the visitor selects it ----
const LAZY_WAIT_MS = 5000;
const isModuleRequest = (url) => /\.wasm$/.test(url) || url.startsWith("data:");
/** The test world (five declared extensions) with one more node that points to a carrier whose status is on a maker. */
function lazyWorld() {
  const test = JSON.parse(JSON.stringify(WORLD));
  const id = Math.max(...test.nodes.map((node) => node.id)) + 1;
  test.nodes.find((node) => node.id === test.root).children.push(id);
  test.nodes.push({ id, parent: test.root, label: "carried", localTransform: IDENTITY, webofworlds_extension: { universal_extension_manifests: [{ url: "carriers/carrier.json" }] } });
  return { world: test, carrier: JSON.stringify(carrierOf({ attach: { kind: "world-node", anchor: String(id) }, statusRef: STATUS_URL })) };
}
/** Mounts `scene` on CARRIER_WORLD with a recording fetch and a stand-in loadExtension. */
async function mountRecorded(scene, files = {}) {
  const seen = [], loads = [];
  const fetch = async (url) => {
    seen.push(String(url));
    if (Object.hasOwn(files, String(url))) return new Response(files[String(url)]);
    if (String(url) === STATUS_URL) return new Response(JSON.stringify(statusAnswer("active")[STATUS_URL].body));
    return new Response("not found", { status: 404 });
  };
  const loadExtension = async (args) => {
    loads.push(args);
    return { ok: true, running: true, nodes: [], shutdown: async () => {}, setGrant: async () => {} };
  };
  const built = buildWowScene(scene, THREE, { source: "check" });
  const mounted = await mountWowExtensions(built.extension_nodes, THREE, { loadExtension, worldUrl: CARRIER_WORLD, pageOrigin: LAB, fetch });
  return { built, mounted, seen, loads, labelOf: (args) => (mounted.records.find((record) => record.validation.ok && record.validation.effective === args.declaration) || {}).label };
}

await check("lazy-no-fetch-at-load", "After world load and five seconds, the mount pass has fetched no module and no status: only the carrier, from the place", async () => {
  const { world: scene, carrier } = lazyWorld();
  const run = await mountRecorded(scene, { [CARRIER_URL]: carrier, [MODULE_URL]: BOX });
  try {
    await sleep(LAZY_WAIT_MS);
    const leaked = run.seen.filter((url) => url !== CARRIER_URL);
    assert(leaked.length === 0, `after load and ${LAZY_WAIT_MS / 1000} s the fetch saw module or status requests: ${JSON.stringify(leaked.map((url) => url.slice(0, 80)))}`);
    assert(run.loads.length === 0, `after load ${run.loads.length} extension(s) were started`);
    const waiting = run.mounted.records.filter((record) => record.status === "not-started").map((record) => record.label);
    assert(waiting.length === 6, `${waiting.length} of 6 extensions wait for selection: ${JSON.stringify(run.mounted.records.map((record) => [record.label, record.status]))}`);
    assert(run.seen.includes(CARRIER_URL), "the carrier on the page's origin was not read at load");
  } finally {
    await run.mounted.unmount();
  }
});

await check("select-starts-one", "Selecting one glance fetches and starts that extension only; the others stay unfetched and not started", async () => {
  const { world: scene, carrier } = lazyWorld();
  const run = await mountRecorded(scene, { [CARRIER_URL]: carrier, [MODULE_URL]: BOX });
  try {
    const box = run.mounted.records.find((record) => record.label === "ue-box");
    assert(box && box.status === "not-started", `ue-box at load: ${box && box.status}`);
    const atLoad = run.seen.length;
    await run.mounted.select(box);
    await sleep(200);
    const asked = run.seen.slice(atLoad);
    const started = run.loads.map(run.labelOf);
    assert(box.status === "mounted", `ue-box after selection: status ${box.status} at ${box.stage}: ${box.error}`);
    assert(started.length === 1 && started[0] === "ue-box", `selecting ue-box started ${JSON.stringify(started)}`);
    assert(asked.length === 1 && asked[0] === MODULE_URL, `selecting ue-box fetched ${JSON.stringify(asked.map((url) => url.slice(0, 80)))}`);
    const others = run.mounted.records.filter((record) => record !== box && record.status !== "not-started").map((record) => `${record.label} ${record.status}`);
    assert(others.length === 0, `other extensions left not-started: ${JSON.stringify(others)}`);
  } finally {
    await run.mounted.unmount();
  }
});

await check("no-rank", "A glance with a rank or priority member is refused at stage declaration; two valid glances are ordered by distance, not by file order", async () => {
  const { glancesOf } = await import("../web/wow-extension-glance.mjs");
  for (const member of ["rank", "priority"]) {
    const declaration = goodDeclaration();
    declaration.glance = { line1: "Box maker", line2: "Makes one box", icon: "shop", action: "Open", [member]: 1 };
    const refused = validateExtensionDeclaration(declaration);
    assert(refused.ok === false && refused.stage === "declaration", `a glance with ${member} gives ${JSON.stringify(refused)}`);
    const built = buildWowScene(world([{ label: `with-${member}`, webofworlds_extension: { universal_extensions: [declaration] } }]), THREE, { source: "check" });
    const [validation] = built.extension_nodes[0].validations;
    assert(validation.ok === false && validation.stage === "declaration", `the world's declaration with ${member} is ${JSON.stringify(validation)}`);
  }
  const at = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const glanced = (line1) => ({ ...goodDeclaration(), glance: { line1, line2: "Makes one box", icon: "shop", action: "Open" } });
  const scene = world([
    { label: "far", localTransform: at(10), webofworlds_extension: { universal_extensions: [glanced("Far box")] } },
    { label: "near", localTransform: at(1), webofworlds_extension: { universal_extensions: [glanced("Near box")] } },
  ]);
  const run = await mountRecorded(scene);
  try {
    const order = glancesOf(run.mounted, [0, 0, 0]).map((item) => item.glance.line1);
    assert(same(order, ["Near box", "Far box"]), `seen from the origin, the glances are ordered ${JSON.stringify(order)}; file order is far first`);
    const fromFar = glancesOf(run.mounted, [11, 0, 0]).map((item) => item.glance.line1);
    assert(same(fromFar, ["Far box", "Near box"]), `seen from x = 11, the glances are ordered ${JSON.stringify(fromFar)}`);
    assert(run.seen.length === 0, `ordering the glances fetched ${JSON.stringify(run.seen)}`);
  } finally {
    await run.mounted.unmount();
  }
});

// ---- The place: a store of module copies and a withdrawn list, on the world file's own origin ----
const PLACE_SCENE = JSON.parse(await readFile(code("src/fixtures/extension-host/world/place-world.json"), "utf8"));
const PLACE_BASE = `${LAB}/place/`;
const PLACE_WORLD = `${PLACE_BASE}place-world.json`;
const MAKER = "http://maker.test";
const ISSUER = "https://issuer.test";
const fixtureBytes = (name) => readFile(code(`src/fixtures/extension-host/world/${name}`));
const STORE = {
  box: `${PLACE_BASE}place-store/sha256-J-MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk.wasm`,
  listener: `${PLACE_BASE}place-store/sha256-cCeNnxXtpBZWwdf9OR9kJQ73A53STaXXV2J_XXVKsJE.wasm`,
  storage: `${PLACE_BASE}place-store/sha256-TX9uK-tiLOEoCoJMP-b1qDjK7TmKBg5iYe4FhhJQ-bI.wasm`,
};
const MAKER_FILES = {
  [`${MAKER}/box-maker.wasm`]: BOX,
  [`${MAKER}/pointer-listener.wasm`]: await fixtureBytes("pointer-listener.wasm"),
  [`${MAKER}/storage-user.wasm`]: await fixtureBytes("storage-user.wasm"),
};
const placeCarrier = (name, anchor) => JSON.stringify(carrierManifest({
  key: KEY_A, id: `urn:uuid:place-carrier-${name}`, facetId: `urn:osl:check:facet:${name}`, subject: `urn:osl:check:world-node:carried-${name}`,
  module: { url: `${MAKER}/box-maker.wasm`, integrity: BOX_MODULE.integrity, binding: BOX_MODULE.binding }, attach: { kind: "world-node", anchor },
  requests: [{ capability: "ue.scene.nodes", purpose: "draw the box" }], statusRef: `${ISSUER}/status/${name}`,
  glance: { line1: `Carried ${name}`, line2: "Signed by its maker", icon: "info", action: "Open" },
}));
const PLACE_FILES = {
  [STORE.box]: await fixtureBytes("place-store/sha256-J-MEtqq8G4EwEbY5a6uiiQeUFTAXd9T4aSX6AiMsHqk.wasm"),
  [STORE.listener]: await fixtureBytes("place-store/sha256-cCeNnxXtpBZWwdf9OR9kJQ73A53STaXXV2J_XXVKsJE.wasm"),
  [`${PLACE_BASE}place-withdrawn.json`]: await fixtureBytes("place-withdrawn.json"),
  [`${PLACE_BASE}carriers/unlisted.json`]: placeCarrier("unlisted", "4"),
  [`${PLACE_BASE}carriers/withdrawn.json`]: placeCarrier("withdrawn", "5"),
};
const toMaker = (urls) => urls.filter((url) => url.startsWith(`${MAKER}/`));
const toIssuer = (urls) => urls.filter((url) => url.startsWith(`${ISSUER}/`));
const short = (urls) => JSON.stringify(urls.map((url) => url.slice(0, 96)));

/**
 * Mounts the place world on PLACE_WORLD with a recording fetch: the place's files (with `files` over them; null removes
 * one), the maker's modules, and nothing for the issuer. `host` uses the real extension host (worker_threads) in place
 * of the stand-in. Returns { mounted, seen, record(label), select(label) -> the requests the selection made }.
 */
async function mountPlace({ files = {}, host = false, ...options } = {}) {
  const served = { ...PLACE_FILES, ...MAKER_FILES, ...files };
  const seen = [];
  const fetch = async (url) => {
    seen.push(String(url));
    return served[String(url)] ? new Response(served[String(url)]) : new Response("not found", { status: 404 });
  };
  const loadExtension = host ? hostLoadExtension : async () => ({ ok: true, running: true, nodes: [], shutdown: async () => {}, setGrant: async () => {} });
  const built = buildWowScene(JSON.parse(JSON.stringify(PLACE_SCENE)), THREE, { source: "check" });
  const mounted = await mountWowExtensions(built.extension_nodes, THREE, { loadExtension, worldUrl: PLACE_WORLD, pageOrigin: LAB, fetch, placeCopies: new Map(), ...options });
  const record = (label) => mounted.records.find((item) => item.label === label) || null;
  const select = async (label) => {
    const from = seen.length;
    await mounted.select(record(label));
    return seen.slice(from);
  };
  return { mounted, seen, record, select };
}
const panelLines = (mounted, record) => {
  const { element } = renderExtensionsPanel({ document: stubDocument(), mounted });
  const row = allUnder(element).find((node) => node.attrs["data-ue-extension"] === `${record.label}#${record.index}`);
  return row ? allUnder(row) : [];
};

await check("place-copy-used", "With a place store, selecting a glance loads the module from the store's copy; the maker origin sees no request", async () => {
  const run = await mountPlace({ host: true, advanceFetch: false });
  try {
    const asked = await run.select("place-box");
    const box = run.record("place-box");
    assert(toMaker(run.seen).length === 0, `selecting place-box asked the maker: ${short(toMaker(run.seen))}`);
    assert(asked.includes(STORE.box), `selecting place-box did not load the store copy: it asked ${short(asked)}`);
    assert(box.status === "mounted" && box.codeSource === "place", `place-box: status ${box.status} at ${box.stage} (${box.error}); codeSource ${JSON.stringify(box.codeSource)}`);
    assert(box.extension && box.extension.nodes.length === 1, `the store copy ran with ${box.extension && box.extension.nodes.length} node(s), not the one Box`);
  } finally {
    await run.mounted.unmount();
  }
});

await check("place-copy-bad-refused", "A store copy with other bytes is refused at integrity, and the maker origin sees no request", async () => {
  const run = await mountPlace({ host: true, files: { [STORE.box]: MAKER_FILES[`${MAKER}/pointer-listener.wasm`] } });
  try {
    await run.mounted.advanceFetchDone;
    await run.select("place-box");
    const box = run.record("place-box");
    assert(toMaker(run.seen).length === 0, `the bad copy: the maker was asked: ${short(toMaker(run.seen))}`);
    assert(box.status === "refused" && box.stage === "integrity", `the bad copy: status ${box.status} at ${box.stage} (${box.error})`);
    assert(box.marker && box.marker.name === `ue-refused:integrity:place-box#0`, `the bad copy has no integrity marker: ${box.marker && box.marker.name}`);
  } finally {
    await run.mounted.unmount();
  }
});

await check("no-copy-marked", "With no copy in the store, the module comes from the maker at selection, the record says codeSource maker, and the panel shows \"code from its maker\"", async () => {
  const run = await mountPlace();
  try {
    await run.mounted.advanceFetchDone;
    const atLoad = run.seen.slice();
    assert(toMaker(atLoad).length === 0, `at load the maker was asked: ${short(toMaker(atLoad))}`);
    const asked = await run.select("maker-only");
    const only = run.record("maker-only");
    assert(only.status === "mounted", `maker-only: status ${only.status} at ${only.stage} (${only.error})`);
    assert(asked.includes(`${MAKER}/storage-user.wasm`), `maker-only did not come from its maker at selection: it asked ${short(asked)}`);
    assert(only.codeSource === "maker", `maker-only: the record says codeSource ${JSON.stringify(only.codeSource)}`);
    const lines = panelLines(run.mounted, only).filter((node) => node.attrs["data-ue-code-source"]);
    assert(lines.length === 1 && lines[0].textContent === "code from its maker" && lines[0].children.length === 0, `maker-only: the panel shows ${JSON.stringify(lines.map((node) => node.textContent))}`);
    await run.select("place-box");
    const placeLines = panelLines(run.mounted, run.record("place-box")).filter((node) => node.attrs["data-ue-code-source"]);
    assert(placeLines.length === 1 && placeLines[0].textContent === "code from this place", `place-box: the panel shows ${JSON.stringify(placeLines.map((node) => node.textContent))}`);
  } finally {
    await run.mounted.unmount();
  }
});

await check("advance-fetch-silent", "With advance fetch, the store copies are fetched at load, and selecting a glance then makes no request of any kind", async () => {
  const run = await mountPlace();
  try {
    await run.mounted.advanceFetchDone;
    const atLoad = run.seen.slice();
    assert(atLoad.includes(STORE.box) && atLoad.includes(STORE.listener), `at load the advance fetch did not fetch the store copies: ${short(atLoad)}`);
    assert(toMaker(atLoad).length === 0 && toIssuer(atLoad).length === 0, `at load the maker or the issuer was asked: ${short([...toMaker(atLoad), ...toIssuer(atLoad)])}`);
    for (const label of ["place-box", "listener", "carried-unlisted"]) {
      const asked = await run.select(label);
      const record = run.record(label);
      assert(asked.length === 0, `selecting ${label} made ${asked.length} request(s): ${short(asked)}`);
      assert(record.status === "mounted" && record.codeSource === "place", `${label}: status ${record.status} at ${record.stage} (${record.error}); codeSource ${JSON.stringify(record.codeSource)}`);
    }
  } finally {
    await run.mounted.unmount();
  }
});

await check("advance-fetch-cap", "With the cap set low, the advance fetch stops at the cap, and the rest load from the store at selection", async () => {
  const run = await mountPlace({ advanceFetchCapBytes: BOX.length + 16 });
  try {
    const ended = await run.mounted.advanceFetchDone;
    const atLoad = run.seen.slice();
    assert(atLoad.includes(STORE.box), `at load the advance fetch did not fetch the first copy: ${short(atLoad)}`);
    assert(!atLoad.includes(STORE.storage), `the advance fetch did not stop at the cap: at load it asked ${short(atLoad)}`);
    assert(ended && ended.bytes <= BOX.length + 16 && ended.stopped, `the advance fetch kept ${ended && ended.bytes} bytes over a cap of ${BOX.length + 16}`);
    const listener = await run.select("listener");
    assert(listener.length === 1 && listener[0] === STORE.listener, `selecting listener, past the cap, asked ${short(listener)}, not its store copy`);
    const box = await run.select("place-box");
    assert(box.length === 0, `selecting place-box, within the cap, asked ${short(box)}`);
    assert(toMaker(run.seen).length === 0, `the maker was asked: ${short(toMaker(run.seen))}`);
  } finally {
    await run.mounted.unmount();
  }
});

await check("status-list-refuses", "A carrier the withdrawn list names as revoked is refused at status at load; no request leaves for its status address, and no module is fetched for it", async () => {
  const run = await mountPlace({ advanceFetch: false });
  try {
    const withdrawn = run.record("carried-withdrawn");
    assert(!run.seen.includes(`${ISSUER}/status/withdrawn`), `a request left for its status address: ${short(toIssuer(run.seen))}`);
    assert(withdrawn && withdrawn.status === "refused" && withdrawn.stage === "status" && /revoked/.test(withdrawn.error || ""), `carried-withdrawn: ${JSON.stringify(withdrawn && { status: withdrawn.status, stage: withdrawn.stage, error: withdrawn.error })}`);
    assert(!withdrawn.selectable, "carried-withdrawn is offered as a glance");
    const asked = await run.select("carried-withdrawn");
    assert(asked.length === 0 && toIssuer(run.seen).length === 0, `selecting the refused carrier asked ${short(asked)}`);
  } finally {
    await run.mounted.unmount();
  }
});

await check("status-unlisted-unchecked", "A carrier with a statusRef the list does not name runs as unchecked, shows \"status not checked\", and its status address sees no request", async () => {
  const run = await mountPlace({ advanceFetch: false });
  try {
    await run.select("carried-unlisted");
    const unlisted = run.record("carried-unlisted");
    assert(!run.seen.includes(`${ISSUER}/status/unlisted`), `its status address saw a request: ${short(toIssuer(run.seen))}`);
    assert(unlisted.status === "mounted" && unlisted.carrier.revocationStatus === "unchecked", `carried-unlisted: status ${unlisted.status} at ${unlisted.stage} (${unlisted.error}); revocationStatus ${JSON.stringify(unlisted.carrier && unlisted.carrier.revocationStatus)}`);
    const lines = panelLines(run.mounted, unlisted).filter((node) => node.textContent === "status not checked");
    assert(lines.length === 1 && lines[0].children.length === 0, `the panel row has ${lines.length} "status not checked" line(s)`);
  } finally {
    await run.mounted.unmount();
  }
});

const SCENE = "web/wow-scene.mjs";
const GLANCE = "web/wow-extension-glance.mjs";
const ADAPTER = "web/wow-extension-manifest-adapter.mjs";
const SIGNING = "web/signing/um-signature-profile-a.mjs";
const CONSENT = "web/wow-extension-consent.mjs";
const MOUNT = "web/wow-extension-mount.mjs";
const PLACE_STORE = "web/wow-extension-place-store.mjs";
await finish({ checkFile: "src/wow-extension-discovery-check.mjs", faults: [
  { statement: "manifest-tampered-refused", name: "the verifier skips the signature comparison", expect: /the tampered carrier: status mounted/,
    edits: [{ file: SIGNING, find: "    ok = await verifyBytes(payload, sigValue, publicKeyInput);", replace: "    ok = true;" }] },
  { statement: "manifest-tampered-refused", name: "fetch the module before verifying", expect: /the tampered carrier: status refused, stage signature; module requests 1/,
    edits: [{ file: ADAPTER, find: "  let signed;\n", replace: "  for (const facet of Array.isArray(manifest.facets) ? manifest.facets : []) {\n    if (facet && facet.entity && facet.entity.module) await fetch(new URL(facet.entity.module.url, manifestUrl).href).catch(() => {});\n  }\n  let signed;\n" }] },
  { statement: "manifest-unsigned-refused", name: "treat a missing signature as valid", expect: /the unsigned carrier: status mounted/,
    edits: [{ file: ADAPTER, find: "if (!isPlainObject(signature)) return { ok: false, detail: \"the manifest has no signature\" };", replace: "if (!isPlainObject(signature)) return { ok: true, key: \"\" };" }] },
  { statement: "manifest-expired-refused", name: "skip the date check", expect: /the expired carrier: status mounted/,
    edits: [{ file: ADAPTER, find: "  if (at >= expires) return refusal(\"validity\",", replace: "  if (false) return refusal(\"validity\"," }] },
  { statement: "manifest-anchor-mismatch", name: "ignore the anchor", expect: /anchored to node 2: status mounted/,
    edits: [{ file: ADAPTER, find: "if (attach.anchor !== undefined && attach.anchor !== String(nodeId)) return fail(", replace: "if (false) return fail(" }] },
  { statement: "manifest-placement-key", name: "key the grant by the manifest @id", expect: /the reissued carrier asks again/,
    edits: [{ file: ADAPTER, find: "      placement: JSON.stringify([manifest.subject, key, attachment]),", replace: "      placement: JSON.stringify(manifest[\"@id\"])," }] },
  { statement: "manifest-fetch-refused", name: "drop a carrier that fails to download", expect: /the missing carrier: no record/,
    edits: [{ file: ADAPTER, find: "    return refusal(\"manifest-fetch\", `${manifestUrl}: ${oneLine(error)}`);", replace: "    return { ok: true, extensions: [] };" }] },
  { statement: "manifest-not-yet-valid", name: "skip the issuedAt check", expect: /the carrier issued in 2099: status mounted/,
    edits: [{ file: ADAPTER, find: "  if (at < issued) return refusal(\"validity\",", replace: "  if (false) return refusal(\"validity\"," }] },
  { statement: "manifest-unknown-attach-kind", name: "read an unknown attach.kind as world-node", expect: /attach\.kind hologram: status mounted/,
    edits: [{ file: ADAPTER, find: "  if (!isPlainObject(attach) || !ATTACH_KINDS.includes(attach.kind)) return fail(",
      replace: "  if (isPlainObject(attach) && !ATTACH_KINDS.includes(attach.kind)) attach.kind = \"world-node\";\n  if (!isPlainObject(attach) || !ATTACH_KINDS.includes(attach.kind)) return fail(" }] },
  { statement: "manifest-request-without-purpose", name: "drop the request without a purpose and run the rest", expect: /a request without purpose: status mounted/,
    edits: [{ file: ADAPTER, find: "  if (!Array.isArray(requests)) return fail(\"requests must be an array\");",
      replace: "  if (!Array.isArray(requests)) return fail(\"requests must be an array\");\n  requests.splice(0, requests.length, ...requests.filter((request) => request && typeof request.purpose === \"string\" && request.purpose.trim()));" }] },
  { statement: "manifest-sha384-refused", name: "accept a sha384- integrity", expect: /the sha384 carrier: status mounted/,
    edits: [{ file: SCENE, find: "const INTEGRITY = /^sha256-[A-Za-z0-9+/]{43}=$/;", replace: "const INTEGRITY = /^(sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64})$/;" }] },
  { statement: "manifest-revoked-refused", name: "the mount ignores the withdrawn list", expect: /the revoked carrier: status mounted/,
    edits: [{ file: MOUNT, find: "      if (WITHDRAWN_STATUSES.includes(status.revocationStatus)) return refuse(record, \"status\",", replace: "      if (false) return refuse(record, \"status\"," }] },
  { statement: "manifest-suspended-refused", name: "treat suspended as active", expect: /the suspended carrier: status mounted/,
    edits: [{ file: PLACE_STORE, find: "export const WITHDRAWN_STATUSES = Object.freeze([\"revoked\", \"suspended\"]);", replace: "export const WITHDRAWN_STATUSES = Object.freeze([\"revoked\"]);" }] },
  { statement: "manifest-status-unchecked-runs", name: "record active when the list did not load", expect: /the carrier whose list did not load: the record says "active"/,
    edits: [{ file: PLACE_STORE, find: "  if (!list.ok) return { revocationStatus: \"unchecked\",", replace: "  if (!list.ok) return { revocationStatus: \"active\"," }] },
  { statement: "manifest-status-signed", name: "a matching signature.statusRef refuses", expect: /the carrier with a matching signature\.statusRef: status refused/,
    edits: [{ file: ADAPTER, find: "  if (unsigned !== undefined && unsigned !== statusRef) {", replace: "  if (unsigned !== undefined) {" }] },
  { statement: "manifest-status-stripped", name: "ignore the mismatch", expect: /signature\.statusRef was redirected: status mounted|does not name signature\.statusRef|only an unsigned signature\.statusRef: status mounted/,
    edits: [{ file: ADAPTER, find: "  if (unsigned !== undefined && unsigned !== statusRef) {", replace: "  if (false) {" }] },
  { statement: "manifest-status-timeout", name: "no time limit", expect: /never answers: no answer after 3000 ms/,
    edits: [{ file: ADAPTER, find: "function withinLimit(work, ms) {\n", replace: "function withinLimit(work, ms) {\n  return work();\n" }] },
  { statement: "status-not-checked-line", name: "the panel omits the line", expect: /the panel row has 0 "status not checked" line/,
    edits: [{ file: CONSENT, find: "      if (record.carrier && record.carrier.revocationStatus === \"unchecked\") {", replace: "      if (false) {" }] },
  { statement: "fetch-aborted", name: "no signal passed", expect: /given no abort signal/,
    edits: [{ file: ADAPTER, find: "return Promise.race([work(controller.signal), limit])", replace: "return Promise.race([work(undefined), limit])" }] },
  { statement: "slow-line", name: "the panel omits the line", expect: /the panel row has 0 "slow" line/,
    edits: [{ file: CONSENT, find: "      if (record.extension && record.extension.overruns > 0) {", replace: "      if (false) {" }] },
  { statement: "hidden-page-pauses", name: "deliver while hidden", expect: /while hidden: [1-9]\d* timer/,
    edits: [{ file: MOUNT, find: "const isHidden = () => !!doc && doc.visibilityState === \"hidden\";", replace: "const isHidden = () => false;" }] },
  { statement: "ext-discover", name: "also push extension nodes into asset_nodes", expect: /extension nodes in asset_nodes/,
    edits: [{ file: SCENE, find: "      extensionNodes.push(record);", replace: "      extensionNodes.push(record);\n      assetNodes.push({ id: record.node_id, label, uri: \"\", group: obj, placeholder: record.placeholder, is_root: isRoot });" }] },
  { statement: "ext-no-suffix-sniff", name: "treat a .wasm suffix as an extension", expect: /a \.wasm address made 1 extension node/,
    edits: [{ file: SCENE, find: "const isExtension = declared !== undefined && declared !== null;",
      replace: "const isExtension = (declared !== undefined && declared !== null) || /\\.wasm$/i.test(String(node.spatialAssetURI || \"\"));" }] },
  { statement: "ext-declaration-refused", name: "skip validateExtensionDeclaration", expect: /without module\.integrity is accepted/,
    edits: [{ file: SCENE, find: "const validations = declarations.map((declaration) => validateExtensionDeclaration(declaration));",
      replace: "const validations = declarations.map((declaration) => ({ ok: true, effective: declaration }));" }] },
  { statement: "lazy-no-fetch-at-load", name: "the mount fetches modules at load", expect: /the fetch saw module or status requests: \[".*wasm/,
    edits: [{ file: MOUNT, find: "    record.status = \"not-started\";\n    record.selectable = true;\n",
      replace: "    void fetchModule(resolveAssetUri(effective.module.url, record.carrier ? record.carrier.manifest_url : worldUrl)).catch(() => {});\n    record.status = \"not-started\";\n    record.selectable = true;\n" }] },
  { statement: "select-starts-one", name: "selection starts every extension", expect: /selecting ue-box started \["[^"]+",/,
    edits: [{ file: MOUNT, find: "    record.status = \"starting\";\n    notifyChange();\n",
      replace: "    record.status = \"starting\";\n    notifyChange();\n    for (const other of records) if (other !== record && other.status === \"not-started\") void select(other);\n" }] },
  { statement: "no-rank", name: "the host honours file order", expect: /the glances are ordered \["Far box","Near box"\]; file order is far first/,
    edits: [{ file: GLANCE, find: ".sort((a, b) => a.distance - b.distance || a.at - b.at)", replace: ".sort((a, b) => a.at - b.at)" }] },
  { statement: "place-copy-used", name: "the mount ignores the store", expect: /selecting place-box asked the maker: \["http:\/\/maker\.test\/box-maker\.wasm"\]/,
    edits: [{ file: MOUNT, find: "    const code = store ? await store.codeOf(effective.module.integrity) : { source: \"maker\" };", replace: "    const code = { source: \"maker\" };" }] },
  { statement: "place-copy-bad-refused", name: "fall back to the maker", expect: /the bad copy: the maker was asked: \["http:\/\/maker\.test\/box-maker\.wasm"\]/,
    edits: [{ file: MOUNT, find: "    const extension = await loadExtension({ bytes, declaration: effective, grant, attachment: record.attachment, ...(storage ? { storage } : {}) });",
      replace: "    let extension = await loadExtension({ bytes, declaration: effective, grant, attachment: record.attachment, ...(storage ? { storage } : {}) });\n    if (extension && !extension.ok && extension.stage === \"integrity\" && record.codeSource === \"place\") {\n      const again = await fetchModule(moduleUrl);\n      extension = await loadExtension({ bytes: new Uint8Array(await again.arrayBuffer()), declaration: effective, grant, attachment: record.attachment });\n    }" }] },
  { statement: "no-copy-marked", name: "the record says place", expect: /maker-only: the record says codeSource "place"/,
    edits: [{ file: MOUNT, find: "    record.codeSource = code.source;", replace: "    record.codeSource = \"place\";" }] },
  { statement: "advance-fetch-silent", name: "selection fetches again", expect: /selecting place-box made 1 request\(s\)/,
    edits: [{ file: PLACE_STORE, find: "    if (copies.has(url)) return { source: \"place\", url, bytes: copies.get(url) };\n", replace: "" }] },
  { statement: "advance-fetch-cap", name: "no cap", expect: /the advance fetch did not stop at the cap/,
    edits: [{ file: PLACE_STORE, find: "      if (total >= cap) { stopped = true; break; }\n", replace: "" },
      { file: PLACE_STORE, find: "      if (total + got.bytes.length > cap) { stopped = true; break; }\n", replace: "" }] },
  { statement: "status-list-refuses", name: "the host asks the issuer", expect: /a request left for its status address: \[.*"https:\/\/issuer\.test\/status\/withdrawn"/,
    edits: [{ file: MOUNT, find: "    if (record.carrier) {\n      // The carrier's status, from the place's withdrawn list only: no issuer is asked.\n",
      replace: "    if (record.carrier && record.carrier.status_ref) void fetchModule(record.carrier.status_ref).catch(() => {});\n    if (record.carrier) {\n" }] },
  { statement: "status-unlisted-unchecked", name: "the host asks the issuer at selection", expect: /its status address saw a request: \["https:\/\/issuer\.test\/status\/unlisted"\]/,
    edits: [{ file: MOUNT, find: "    if (!loadExtension) return fail(record, \"worker\", \"no extension host injected\");\n",
      replace: "    if (!loadExtension) return fail(record, \"worker\", \"no extension host injected\");\n    if (record.carrier && record.carrier.status_ref) await fetchModule(record.carrier.status_ref).catch(() => {});\n" }] },
  { statement: "ext-schema-strict", name: "add a member to the list only", expect: /is not the schema's/,
    edits: [{ file: SCENE, find: "\"module\", \"interface\", \"attach\", \"requests\", \"limits\", \"data\",", replace: "\"module\", \"interface\", \"attach\", \"requests\", \"limits\", \"data\", \"extra\"," }] },
] });
