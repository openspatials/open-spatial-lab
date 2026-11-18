// Extension discovery in a world file, in Node: buildWowScene finds the nodes that carry
// `webofworlds_extension.universal_extensions`, checks each declaration against the strict
// `UniversalExtensionDeclaration` schema, and keeps a visible marker for every refused one. Nothing is fetched or run
// here; the mount pass (web/wow-extension-mount.mjs) does that, and src/wow-extension-mount-browser-check.mjs checks it.
//
// The manifest-* cases run the mount pass in Node on a node that points to a signed carrier manifest
// (`webofworlds_extension.universal_extension_manifests`), with a recording fetch in place of a test server (every
// request the pass makes goes through it) and a loadExtension that only records what it is given.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";
import { buildWowScene, validateExtensionDeclaration, EXTENSION_DECLARATION_MEMBERS } from "../web/wow-scene.mjs";
import { mountWowExtensions } from "../web/wow-extension-mount.mjs";
import { createGrantStore } from "../web/wow-extension-consent.mjs";
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

/** Mounts a one-node world whose node points to the carrier `text`; returns the record, the requests and the loads. */
async function mountCarrier(text, { grantStore } = {}) {
  const seen = [], loads = [];
  const files = { [CARRIER_URL]: text, [MODULE_URL]: BOX };
  const recordingFetch = async (url) => {
    seen.push(String(url));
    return Object.hasOwn(files, String(url)) ? new Response(files[String(url)]) : new Response("not found", { status: 404 });
  };
  const loadExtension = async (args) => {
    loads.push(args);
    return { ok: true, running: true, nodes: [], shutdown: async () => {}, setGrant: async () => {} };
  };
  const built = buildWowScene(world([{ label: "carried", webofworlds_extension: { universal_extension_manifests: [{ url: "carriers/carrier.json" }] } }]), THREE, { source: "check" });
  const mounted = await mountWowExtensions(built.extension_nodes, THREE, { loadExtension, worldUrl: CARRIER_WORLD, pageOrigin: LAB, fetch: recordingFetch, ...(grantStore ? { grantStore } : {}) });
  const record = mounted.records.find((item) => item.label === "carried") || null;
  const status = record ? record.status : null;
  const marker = record && record.marker ? { name: record.marker.name, stage: record.marker.userData.ueStage, under: objectsUnder(built.extension_nodes[0].group).includes(record.marker) } : null;
  await mounted.unmount();
  const modules = seen.filter((url) => url === MODULE_URL).length;
  const state = record ? `status ${status}, stage ${record.stage}` : "no record";
  return { built, mounted, record, status, marker, seen, loads, modules, says: `${state}; module requests ${modules}; loads ${loads.length}` };
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

const SCENE = "web/wow-scene.mjs";
const ADAPTER = "web/wow-extension-manifest-adapter.mjs";
const SIGNING = "web/signing/um-signature-profile-a.mjs";
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
