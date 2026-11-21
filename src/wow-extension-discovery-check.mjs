// Extension discovery in a world file, in Node: buildWowScene finds the nodes that carry
// `webofworlds_extension.universal_extensions`, checks each declaration against the strict
// `UniversalExtensionDeclaration` schema, and keeps a visible marker for every refused one. Nothing is fetched or run
// here; the mount pass (web/wow-extension-mount.mjs) does that, and src/wow-extension-mount-browser-check.mjs checks it.
//
// The manifest-* cases run the mount pass in Node on a node that points to a signed carrier manifest
// (`webofworlds_extension.universal_extension_manifests`), with a recording fetch in place of a test server (every
// request the pass makes goes through it) and a loadExtension that only records what it is given. hidden-page-pauses
// runs the mount pass with the real extension host (worker_threads) and a document stand-in whose visibility it sets.
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
async function mountCarrier(text, { grantStore, answers = {}, fetchLimitMs, extension = {} } = {}) {
  const seen = [], loads = [], signals = new Map();
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
  const built = buildWowScene(world([{ label: "carried", webofworlds_extension: { universal_extension_manifests: [{ url: "carriers/carrier.json" }] } }]), THREE, { source: "check" });
  const mounted = await mountWowExtensions(built.extension_nodes, THREE, { loadExtension, worldUrl: CARRIER_WORLD, pageOrigin: LAB, fetch: recordingFetch, ...(grantStore ? { grantStore } : {}), ...(fetchLimitMs ? { fetchLimitMs } : {}) });
  const record = mounted.records.find((item) => item.label === "carried") || null;
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

// ---- The extension's status (the signed entity.statusRef, resolved before any module is fetched) ----
const STATUS_URL = "https://status.test/manifests/check-carrier-1";
const statusAnswer = (status) => ({ [STATUS_URL]: { status: 200, body: { manifestId: "urn:uuid:check-carrier-1", status, updatedAt: "2026-11-17T00:00:00.000Z" } } });
const withStatus = () => JSON.stringify(carrierOf({ statusRef: STATUS_URL }));
const askedStatus = (run) => run.seen.includes(STATUS_URL);

await check("manifest-revoked-refused", "A correctly signed carrier whose status is revoked is refused at status, and no module is requested", async () => {
  const run = await mountCarrier(withStatus(), { answers: statusAnswer("revoked") });
  assert(refusedAt(run, "status"), `the revoked carrier: ${run.says}`);
  assert(/revoked/.test(detailOf(run)), `the refusal does not say revoked: ${JSON.stringify(detailOf(run))}`);
  assert(run.marker && run.marker.under && run.marker.stage === "status", `no status marker under the node: ${JSON.stringify(run.marker)}`);
  const active = await mountCarrier(withStatus(), { answers: statusAnswer("active") });
  assert(active.status === "mounted" && askedStatus(active), `the active carrier: ${active.says}; status asked ${askedStatus(active)} (${active.record && active.record.error})`);
});

await check("manifest-suspended-refused", "A correctly signed carrier whose status is suspended is refused at status, and no module is requested", async () => {
  const run = await mountCarrier(withStatus(), { answers: statusAnswer("suspended") });
  assert(refusedAt(run, "status"), `the suspended carrier: ${run.says}`);
  assert(/suspended/.test(detailOf(run)), `the refusal does not say suspended: ${JSON.stringify(detailOf(run))}`);
});

await check("manifest-status-unchecked-runs", "A carrier whose status endpoint is unavailable runs, and its record says unchecked with the reason", async () => {
  const run = await mountCarrier(withStatus(), { answers: { [STATUS_URL]: { status: 503 } } });
  const carrier = (run.record && run.record.carrier) || {};
  assert(run.status === "mounted" && askedStatus(run), `the carrier with no status answer: ${run.says}; status asked ${askedStatus(run)} (${run.record && run.record.error})`);
  assert(carrier.revocationStatus === "unchecked", `the carrier with no status answer: the record says ${JSON.stringify(carrier.revocationStatus)}, not unchecked`);
  assert(/endpoint-unavailable/.test(carrier.revocationReason || ""), `the unchecked record gives no reason: ${JSON.stringify(carrier.revocationReason)}`);
  const plain = await mountCarrier(JSON.stringify(carrierOf()));
  const plainCarrier = (plain.record && plain.record.carrier) || {};
  assert(plain.status === "mounted" && plainCarrier.revocationStatus === "unchecked", `the carrier without statusRef: ${plain.says}, revocationStatus ${JSON.stringify(plainCarrier.revocationStatus)}`);
});


// ---- The status address is signed (entity.statusRef); an unsigned one is never used; fetches have a time limit ----
await check("manifest-status-signed", "An extension whose signed entity.statusRef says revoked is refused at status, with or without a matching signature.statusRef", async () => {
  const signedOnly = await mountCarrier(JSON.stringify(carrierOf({ statusRef: STATUS_URL })), { answers: statusAnswer("revoked") });
  assert(refusedAt(signedOnly, "status") && askedStatus(signedOnly), `the revoked extension with only entity.statusRef: ${signedOnly.says}; status asked ${askedStatus(signedOnly)}`);
  const both = await mountCarrier(JSON.stringify(carrierOf({ statusRef: STATUS_URL, signatureStatusRef: STATUS_URL })), { answers: statusAnswer("revoked") });
  assert(refusedAt(both, "status") && /revoked/.test(detailOf(both)), `the revoked extension with a matching signature.statusRef: ${both.says} (${detailOf(both)})`);
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
await check("manifest-status-timeout", "A status endpoint that never answers gives unchecked within the time limit, and the extension runs; a carrier that never answers is refused at manifest-fetch", async () => {
  const started = Date.now();
  const run = await guarded("the carrier whose status endpoint never answers", () => mountCarrier(withStatus(), { answers: { [STATUS_URL]: { never: true } }, fetchLimitMs: LIMIT_MS }));
  const carrier = (run.record && run.record.carrier) || {};
  assert(run.status === "mounted" && askedStatus(run) && carrier.revocationStatus === "unchecked",
    `the carrier whose status endpoint never answers: ${run.says}; status asked ${askedStatus(run)}; revocationStatus ${JSON.stringify(carrier.revocationStatus)}`);
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
await check("fetch-aborted", "A carrier fetch and a status fetch that never answer are aborted at the time limit: each fetch sees its signal aborted", async () => {
  const status = await guarded("the carrier whose status endpoint never answers", () => mountCarrier(withStatus(), { answers: { [STATUS_URL]: { never: true } }, fetchLimitMs: LIMIT_MS }));
  const statusSignal = status.signals.get(STATUS_URL);
  assert(statusSignal, "the status fetch was given no abort signal");
  assert(statusSignal.aborted, "the status fetch's signal was not aborted at the time limit");
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

const SCENE = "web/wow-scene.mjs";
const ADAPTER = "web/wow-extension-manifest-adapter.mjs";
const SIGNING = "web/signing/um-signature-profile-a.mjs";
const CONSENT = "web/wow-extension-consent.mjs";
const MOUNT = "web/wow-extension-mount.mjs";
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
  { statement: "manifest-revoked-refused", name: "skip the status call", expect: /the revoked carrier: status mounted/,
    edits: [{ file: ADAPTER, find: "  const statuses = await Promise.all(facets.map((facet) => extensionStatus(manifest, facet, { fetch, statusTransport, limitMs, answers })));",
      replace: "  const statuses = facets.map(() => ({ revocationStatus: \"unchecked\", reason: null }));" }] },
  { statement: "manifest-suspended-refused", name: "treat suspended as active", expect: /the suspended carrier: status mounted/,
    edits: [{ file: ADAPTER, find: "const REFUSED_STATUSES = new Set([\"revoked\", \"suspended\"]);", replace: "const REFUSED_STATUSES = new Set([\"revoked\"]);" }] },
  { statement: "manifest-status-unchecked-runs", name: "record active when the endpoint did not answer", expect: /the carrier with no status answer: the record says "active"/,
    edits: [{ file: ADAPTER, find: "  const revocation = { revocationStatus: status.revocationStatus, revocationReason: status.reason };",
      replace: "  const revocation = { revocationStatus: status.revocationStatus === \"unchecked\" ? \"active\" : status.revocationStatus, revocationReason: status.reason };" }] },
  { statement: "manifest-status-signed", name: "read the address from signature.statusRef only", expect: /the revoked extension with only entity\.statusRef: status mounted/,
    edits: [{ file: ADAPTER, find: "  const statusRef = facet.entity.statusRef;", replace: "  const statusRef = signature.statusRef;" }] },
  { statement: "manifest-status-stripped", name: "ignore the mismatch", expect: /does not name signature\.statusRef|only an unsigned signature\.statusRef: status mounted/,
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
  { statement: "ext-schema-strict", name: "add a member to the list only", expect: /is not the schema's/,
    edits: [{ file: SCENE, find: "\"module\", \"interface\", \"attach\", \"requests\", \"limits\", \"data\",", replace: "\"module\", \"interface\", \"attach\", \"requests\", \"limits\", \"data\", \"extra\"," }] },
] });
