import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPresentationJsonLines,
  normalizePresentationPath,
  redactPresentationValue,
} from "../web/presentation-json-viewer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerSource = fs.readFileSync(path.join(ROOT, "web/presentation-json-viewer.mjs"), "utf8");
const controllerSource = fs.readFileSync(path.join(ROOT, "web/panel-truth-chrome-controller.mjs"), "utf8");
const indexSource = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(ROOT, "web/presentation-json-viewer.css"), "utf8");

const protectedSample = {
  id: "demo-room-a",
  label: "Portal to Location B",
  destination: {
    target_world_id: "demo-room-b",
    target_spatial_graph_endpoint: "http://127.0.0.1:18151/wow/spatial/demo-room-b",
  },
  location: { port: 18151 },
  spatialAssetURI: "https://assets.example.invalid/models/AntiqueCamera.glb",
  session_id: "session-private-314",
  display_name: "Private Person",
  captured_at: "2026-07-18T19:23:50.000Z",
  signature: {
    algorithm: "Ed25519",
    canonicalization: "JCS-RFC8785",
    value: "signature-private-314",
  },
  local_path: "local-path",
  children: [{ id: 2, spatialAssetURI: "https://assets.example.invalid/models/ToyCar.glb" }],
};
const originalSample = JSON.stringify(protectedSample);
const redaction = redactPresentationValue(protectedSample, { sourceKind: "portal" });
const redactedText = JSON.stringify(redaction.value);

assert.equal(JSON.stringify(protectedSample), originalSample, "redaction must not mutate application state");
assert.equal(redaction.value.id, "demo-room-a", "world/portal identifiers remain available for the recording beat");
assert.equal(redaction.value.destination.target_world_id, "demo-room-b");
assert.equal(redaction.value.signature.algorithm, "Ed25519");
assert.equal(redaction.value.signature.canonicalization, "JCS-RFC8785");
assert.equal(redaction.value.signature.value, "[redacted]");
assert.equal(redaction.value.session_id, "[redacted]");
assert.equal(redaction.value.display_name, "[redacted]");
assert.equal(redaction.value.captured_at, "[redacted]");
assert.match(redaction.value.destination.target_spatial_graph_endpoint, /^\[origin redacted\]\//);
assert.match(redaction.value.spatialAssetURI, /^\[origin redacted\]\//);
assert.equal(redaction.value.location.port, "[redacted]");
assert.doesNotMatch(redactedText, /session-private-314|Private Person|signature-private-314|\/Users\/example|:18151/);
assert.equal(redaction.redacted, true);
assert(redaction.redactedPaths.includes("/signature/value"));

const userRedaction = redactPresentationValue({ id: 17, AvatarURI: "", geoPose: {} }, { sourceKind: "user" });
assert.equal(userRedaction.value.id, "[redacted]", "raw numeric user identifiers are not presentation-safe");
assert.equal(userRedaction.value.AvatarURI, "");

const manifestRedaction = redactPresentationValue({
  "@id": "urn:uuid:f93c4e95-15dc-4a65-810c-d6658ddc92c5",
  subject: "did:web:demo.local:user:avatar-local-001",
  issuedAt: "2026-07-19T05:11:22.480Z",
  pointers: [{ url: "/api/a/fabric.json/sessions/omb-ctx-private-314/context" }],
  users: [{ id: 1002, endpoint: "/wow/user/1002" }],
  view: { kind: "player-view-camera" },
}, { sourceKind: "manifest" });
const manifestText = JSON.stringify(manifestRedaction.value);
assert.equal(manifestRedaction.value["@id"], "[redacted]");
assert.equal(manifestRedaction.value.subject, "[redacted]");
assert.equal(manifestRedaction.value.issuedAt, "[redacted]");
assert.equal(manifestRedaction.value.users[0].id, "[redacted]");
assert.equal(manifestRedaction.value.view.kind, "player-view-camera");
assert.doesNotMatch(manifestText, /f93c4e95|did:web|omb-ctx-private-314|\/wow\/user\/1002|"id":1002/);

assert.deepEqual(normalizePresentationPath("/destination/target_world_id"), {
  ok: true,
  pointer: "/destination/target_world_id",
});
assert.deepEqual(normalizePresentationPath("destination.target_world_id"), {
  ok: true,
  pointer: "/destination/target_world_id",
});
assert.deepEqual(normalizePresentationPath("children[0].spatialAssetURI"), {
  ok: true,
  pointer: "/children/0/spatialAssetURI",
});
assert.equal(normalizePresentationPath("children[nope]").ok, false);
assert.equal(normalizePresentationPath("/bad~2escape").ok, false);

const lines = buildPresentationJsonLines(redaction.value);
assert(lines.some((line) => line.pointer === "/destination/target_world_id"));
assert(lines.some((line) => line.pointer === "/children/0/spatialAssetURI"));
assert(lines.some((line) => line.depth >= 2), "deep JSON remains structurally navigable");
assert(lines.some((line) => line.tokens.some((token) => token.kind === "key")));
assert(lines.some((line) => line.tokens.some((token) => token.kind === "string")));

const emptyObjectLines = buildPresentationJsonLines({});
const emptyArrayLines = buildPresentationJsonLines([]);
const emptyResponseLines = buildPresentationJsonLines(null);
const longValue = "long-value-".repeat(120);
const longValueLines = buildPresentationJsonLines({ nested: { items: [longValue] } });
assert.equal(emptyObjectLines.map((line) => line.tokens.map((token) => token.text).join("")).join(""), "{}");
assert.equal(emptyArrayLines.map((line) => line.tokens.map((token) => token.text).join("")).join(""), "[]");
assert.equal(emptyResponseLines[0].tokens[0].text, "null");
assert(longValueLines.some((line) => line.pointer === "/nested/items/0"));
assert(longValueLines.some((line) => line.tokens.some((token) => token.text.includes(longValue))));

function contractErrors(sources) {
  const errors = [];
  const buttonCount = (sources.index.match(/data-presentation-source=/g) || []).length;
  if (buttonCount !== 3) errors.push(`expected three eligible preview buttons, found ${buttonCount}`);
  if (!sources.index.includes("<dialog class=\"presentation-json-dialog\"")) errors.push("native modal dialog missing");
  if (!sources.index.includes("data-testid=\"presentation-json-close\"")) errors.push("visible close missing");
  if (!sources.index.includes("aria-hidden=\"true\"")) errors.push("closed accessibility state missing");
  if (!sources.css.includes("90dvw") || !sources.css.includes("90dvh")) errors.push("90% viewport geometry missing");
  if (!sources.css.includes("font: 19px/1.58")) errors.push("presentation font contract missing");
  if (!sources.css.includes(".presentation-json-dialog:not([open])")) errors.push("hidden dialog interaction guard missing");
  if (!sources.controller.includes("presentationViewer.present(\"std-um-json-view\", manifest")) errors.push("manifest source binding missing");
  if (!sources.controller.includes("presentationViewer.present(targetId, value")) errors.push("Web of Worlds source binding missing");
  if (!sources.viewer.includes("if (event.target === dialog) close();")) errors.push("backdrop-only dismissal guard missing");
  if (!sources.viewer.includes("trigger.focus({ preventScroll: true })")) errors.push("exact focus restoration missing");
  if (!sources.viewer.includes("Path not found:")) errors.push("unresolved path failure state missing");
  if (!sources.viewer.includes("SECRET_KEY_PATTERN") || !sources.viewer.includes("INTERNAL_PORT_KEY_PATTERN")) errors.push("protected-value redaction contract missing");
  if (/\bfetch\s*\(/.test(sources.viewer)) errors.push("viewer must not fetch");
  return errors;
}

const productionSources = {
  viewer: viewerSource,
  controller: controllerSource,
  index: indexSource,
  css: cssSource,
};
assert.deepEqual(contractErrors(productionSources), []);

const negativeMutations = [
  {
    name: "wrong preview source",
    sources: { ...productionSources, index: indexSource.replace('data-presentation-source="std-um-json-view"', 'data-unbound-source="std-um-json-view"') },
  },
  {
    name: "inside click also closes",
    sources: { ...productionSources, viewer: viewerSource.replace("event.target === dialog", "true") },
  },
  {
    name: "backdrop click does not close",
    sources: { ...productionSources, viewer: viewerSource.replace("if (event.target === dialog) close();", "void event.target;") },
  },
  {
    name: "opening refetches",
    sources: { ...productionSources, viewer: `${viewerSource}\nfetch('/wrong-source');` },
  },
  {
    name: "focus restoration removed",
    sources: { ...productionSources, viewer: viewerSource.replace("trigger.focus({ preventScroll: true })", "void trigger") },
  },
  {
    name: "center-third geometry shrunk",
    sources: { ...productionSources, css: cssSource.replace("90dvw", "60dvw") },
  },
  {
    name: "hidden dialog remains interactive",
    sources: { ...productionSources, css: cssSource.replace(".presentation-json-dialog:not([open])", ".presentation-json-dialog.was-open") },
  },
  {
    name: "missing path represented as success",
    sources: { ...productionSources, viewer: viewerSource.replace("Path not found:", "Highlighted missing path:") },
  },
  {
    name: "internal-port redaction removed",
    sources: { ...productionSources, viewer: viewerSource.replaceAll("INTERNAL_PORT_KEY_PATTERN", "REMOVED_PORT_KEY_PATTERN") },
  },
];
for (const mutation of negativeMutations) {
  assert.notDeepEqual(contractErrors(mutation.sources), [], `negative control must fail: ${mutation.name}`);
}

process.stdout.write("runtime presentation JSON viewer deterministic checks: PASS\n");
process.stdout.write(`redacted paths: ${redaction.redactedPaths.join(", ")}\n`);
process.stdout.write(`negative controls: ${negativeMutations.length}/${negativeMutations.length} rejected\n`);
