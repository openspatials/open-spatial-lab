// web/wow-extension-manifest-adapter.mjs
//
// The second way a world node declares an extension: `webofworlds_extension.universal_extension_manifests` points to
// signed carrier manifests (Universal Manifest v0.6), each extension a facet whose @type includes um:Facet and
// osl:ExtensionFacet and whose entity @type includes osl:Extension (docs/universal-extensions/UM-PROFILE-PROPOSAL.md,
// sections 2.1 and 2.4). This adapter turns one carrier into the declarations the mount pass already runs.
//
// The order: fetch the manifest (stage `manifest-fetch`); verify the signature over the whole manifest, with the key in
// signature.publicKeySpkiB64 (stage `signature`); check issuedAt and expiresAt against the clock (stage `validity`);
// only then read the facets (stage `facet`, per extension). Nothing names a module before the signature passes, so the
// mount fetches no module of a carrier that fails.
//
// fetch, the clock and the verifier are injected. The verifier is the Lab's Signature Profile A verifier
// (web/signing/um-signature-profile-a.mjs, verifyManifestProfileA), which the mount pass gives by default.
import { validateExtensionDeclaration } from "./wow-scene.mjs";
import { parseIJson } from "./signing/ijson.mjs";

const MIB = 1024 * 1024;
const ATTACH_KINDS = ["world-node", "app-panel", "device", "person"];
const LIMITS = ["memoryMiB", "initMs", "eventMs", "timers"];
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const typesOf = (value) => (Array.isArray(value) ? value : [value]);
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const refusal = (stage, detail) => ({ ok: false, stage, detail });

/** True for a facet that declares an extension. Other facets are not read. */
export function isExtensionFacet(facet) {
  return isPlainObject(facet) && typesOf(facet["@type"]).includes("um:Facet") && typesOf(facet["@type"]).includes("osl:ExtensionFacet")
    && isPlainObject(facet.entity) && typesOf(facet.entity["@type"]).includes("osl:Extension");
}

/** { ok: true, key } with the key the signature verified under, or { ok: false, detail }. */
async function verifiedKey(manifest, verify) {
  const signature = manifest.signature;
  if (!isPlainObject(signature)) return { ok: false, detail: "the manifest has no signature" };
  if (typeof signature.publicKeySpkiB64 !== "string" || !signature.publicKeySpkiB64) return { ok: false, detail: "the signature carries no publicKeySpkiB64" };
  const report = await verify(manifest);
  return report && report.ok ? { ok: true, key: signature.publicKeySpkiB64 } : { ok: false, detail: `the signature does not verify (${(report && report.reason) || "no report"})` };
}

/** One extension facet -> { ok: true, effective, carrier } or { ok: false, stage: "facet", detail }. */
function readFacet(facet, { manifest, manifestUrl, key, nodeId }) {
  const fail = (detail) => refusal("facet", `${facet["@id"] || "facet"}: ${detail}`);
  const { module, interface: iface, attach, requests, limits } = facet.entity;
  if (!isPlainObject(attach) || !ATTACH_KINDS.includes(attach.kind)) return fail(`attach.kind must be one of [${ATTACH_KINDS.join(", ")}]`);
  if (Object.keys(attach).some((name) => name !== "kind" && name !== "anchor")) return fail("attach has a member other than kind and anchor");
  if (attach.kind !== "world-node") return fail(`attach.kind ${attach.kind} is not accepted here; only world-node`);
  if (attach.anchor !== undefined && attach.anchor !== String(nodeId)) return fail(`attach.anchor ${JSON.stringify(attach.anchor)} is not the carrying node ${nodeId}`);
  if (!Array.isArray(requests)) return fail("requests must be an array");
  for (const [index, request] of requests.entries()) {
    if (!isPlainObject(request) || typeof request.capability !== "string" || !request.capability) return fail(`requests[${index}] has no capability`);
    if (typeof request.purpose !== "string" || !request.purpose.trim()) return fail(`requests[${index}] (${request.capability}) has no purpose; the whole extension is refused`);
  }
  const budgets = {};
  if (limits !== undefined) {
    if (!isPlainObject(limits)) return fail("limits must be an object");
    for (const [name, value] of Object.entries(limits)) {
      if (!LIMITS.includes(name) || !Number.isInteger(value) || value <= 0) return fail(`limits.${name} must be one of [${LIMITS.join(", ")}] with a positive integer`);
    }
    // The author's budgets may only lower the host's (the host enforces its own); timers has no Lab member.
    if (limits.initMs !== undefined) budgets.initMs = limits.initMs;
    if (limits.eventMs !== undefined) budgets.eventMs = limits.eventMs;
    if (limits.memoryMiB !== undefined) budgets.memoryBytes = limits.memoryMiB * MIB;
  }
  const validation = validateExtensionDeclaration({
    module, interface: iface, attach: { kind: attach.kind }, limits: budgets,
    requests: requests.map((request) => request.capability),
    purposes: Object.fromEntries(requests.map((request) => [request.capability, request.purpose])),
  });
  if (!validation.ok) return fail(validation.detail);
  const attachment = { kind: attach.kind, ...(attach.anchor === undefined ? {} : { anchor: attach.anchor }) };
  return {
    ok: true,
    effective: validation.effective,
    carrier: {
      subject: manifest.subject, key, attach: attachment, manifest_url: manifestUrl, facet_id: facet["@id"] || null,
      // The placement of profile section 2.4 (with module.integrity, which the mount adds): never the @ids.
      placement: JSON.stringify([manifest.subject, key, attachment]),
    },
  };
}

/**
 * readCarrierManifest({ manifestUrl, nodeId, fetch, now, verify }) -> Promise<{ ok: true, extensions: [...] } |
 * { ok: false, stage, detail }>. Each extension is { ok: true, effective, carrier } or { ok: false, stage: "facet",
 * detail }. `nodeId` is the carrying node's id in the world file, which attach.anchor must equal when present. Never
 * rejects.
 */
export async function readCarrierManifest({ manifestUrl, nodeId, fetch, now = () => Date.now(), verify }) {
  let manifest;
  try {
    const response = await fetch(manifestUrl);
    if (!response || !response.ok) throw new Error(`HTTP ${response && response.status}`);
    manifest = parseIJson(await response.text());
  } catch (error) {
    return refusal("manifest-fetch", `${manifestUrl}: ${oneLine(error)}`);
  }
  if (!isPlainObject(manifest)) return refusal("manifest-fetch", `${manifestUrl}: not a JSON object`);
  if (manifest.manifestVersion !== "0.6") return refusal("signature", `manifestVersion must be "0.6"; got ${JSON.stringify(manifest.manifestVersion)}`);
  let signed;
  try {
    signed = await verifiedKey(manifest, verify);
  } catch (error) {
    signed = { ok: false, detail: oneLine(error) };
  }
  if (!signed.ok) return refusal("signature", signed.detail);
  const at = now();
  const issued = Date.parse(manifest.issuedAt), expires = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return refusal("validity", "issuedAt and expiresAt must be dates");
  if (at < issued) return refusal("validity", `not yet valid: issuedAt ${manifest.issuedAt}`);
  if (at >= expires) return refusal("validity", `expired: expiresAt ${manifest.expiresAt}`);
  if (typeof manifest.subject !== "string" || !manifest.subject) return refusal("facet", "the manifest has no subject");
  const facets = Array.isArray(manifest.facets) ? manifest.facets.filter(isExtensionFacet) : [];
  return { ok: true, extensions: facets.map((facet) => readFacet(facet, { manifest, manifestUrl, key: signed.key, nodeId })) };
}

export default { readCarrierManifest, isExtensionFacet };
