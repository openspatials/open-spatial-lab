// web/wow-extension-manifest-adapter.mjs
//
// The second way a world node declares an extension: `webofworlds_extension.universal_extension_manifests` points to
// signed carrier manifests (Universal Manifest v0.6), each extension a facet whose @type includes um:Facet and
// osl:ExtensionFacet and whose entity @type includes osl:Extension (docs/universal-extensions/UM-PROFILE-PROPOSAL.md,
// sections 2.1 and 2.4). This adapter turns one carrier into the declarations the mount pass already runs.
//
// The order at world load: fetch the manifest (stage `manifest-fetch`); verify the signature over the whole manifest,
// with the key in signature.publicKeySpkiB64 (stage `signature`); check issuedAt and expiresAt against the clock (stage
// `validity`); then, per extension facet, check its status address and read it (stage `facet`), with its glance. The
// status address is the extension entity's statusRef, which the signature covers (profile section 2.1);
// signature.statusRef is outside the signing input, so it is never used: present and not equal to entity.statusRef (or
// present without one), the extension is refused at stage `status`, with no request.
//
// The status address is a declaration check only: it is never fetched, at world load or at selection, so no issuer
// learns what a visitor looked at. Whether a carrier is withdrawn comes from the place's withdrawn list, read once at
// world load by the mount pass (web/wow-extension-place-store.mjs); each carrier record carries its manifest @id for
// that, and the signed status address as data.
//
// The carrier fetch stops after FETCH_LIMIT_MS (10 s; `fetchLimitMs` overrides it): a carrier that does not answer in
// time is refused at `manifest-fetch`. The fetch is given an abort signal (fetch(url, { signal })), which is aborted at
// the limit, so the request does not stay open.
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
/** The time limit of one fetch (a carrier, or the place's withdrawn list), in milliseconds. */
export const FETCH_LIMIT_MS = 10000;

/** work(signal) settled within ms, or rejected with "no answer within <ms> ms"; at the limit the signal is aborted. */
export function withinLimit(work, ms) {
  let timer;
  const controller = new AbortController();
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${ms} ms`));
    }, ms);
  });
  return Promise.race([work(controller.signal), limit]).finally(() => clearTimeout(timer));
}

/**
 * One extension's status address: { statusRef } (undefined when it has none) or { refused: detail }. The address is
 * the signed entity.statusRef; an unsigned signature.statusRef that differs from it (or stands alone) is tampering and
 * refuses. Needs no request; the address is never fetched.
 */
function statusAddress(manifest, facet) {
  const signature = isPlainObject(manifest.signature) ? manifest.signature : {};
  const statusRef = facet.entity.statusRef;
  const unsigned = signature.statusRef;
  if (unsigned !== undefined && unsigned !== statusRef) {
    return { refused: `signature.statusRef ${JSON.stringify(unsigned)} is not the signed entity.statusRef ${JSON.stringify(statusRef === undefined ? null : statusRef)}; an unsigned status address is never used` };
  }
  return { statusRef };
}

/**
 * keyFingerprint(publicKeySpkiB64) -> Promise<string>: the key's fingerprint as the consent dialog shows it, the
 * SHA-256 of the SPKI DER bytes, the first 16 hexadecimal characters in groups of four ("3fa9 01bc 77d2 e410").
 */
export async function keyFingerprint(spkiB64) {
  const der = Uint8Array.from(atob(spkiB64), (char) => char.charCodeAt(0));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", der));
  const hex = [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g).join(" ");
}

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

/** One extension facet -> { ok: true, effective, carrier } or { ok: false, stage: "status" | "facet", detail }. */
function readFacet(facet, { manifest, manifestUrl, key, fingerprint, nodeId, address }) {
  if (address.refused) return refusal("status", `${facet["@id"] || "facet"}: ${address.refused}`);
  const fail = (detail) => refusal("facet", `${facet["@id"] || "facet"}: ${detail}`);
  const { module, interface: iface, attach, requests, limits, glance } = facet.entity;
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
    ...(glance === undefined ? {} : { glance }),
  });
  if (!validation.ok) return fail(validation.detail);
  const attachment = { kind: attach.kind, ...(attach.anchor === undefined ? {} : { anchor: attach.anchor }) };
  return {
    ok: true,
    effective: validation.effective,
    carrier: {
      subject: manifest.subject, key, fingerprint, attach: attachment, manifest_url: manifestUrl, facet_id: facet["@id"] || null,
      // The manifest @id the place's withdrawn list names, and the signed status address, kept as data and never fetched.
      manifest_id: typeof manifest["@id"] === "string" ? manifest["@id"] : null, status_ref: address.statusRef === undefined ? null : address.statusRef,
      // Set by the mount pass from the place's withdrawn list: "unchecked" for a carrier that runs, with the reason.
      revocationStatus: null, revocationReason: null,
      // The placement of profile section 2.4 (with module.integrity, which the mount adds): never the @ids.
      placement: JSON.stringify([manifest.subject, key, attachment]),
    },
  };
}

/**
 * readCarrierManifest({ manifestUrl, nodeId, fetch, now, verify, fetchLimitMs }) -> Promise<{ ok: true, extensions: [...] }
 * | { ok: false, stage, detail }>. Each extension is { ok: true, effective, carrier } or { ok: false, stage: "status" |
 * "facet", detail }. `nodeId` is the carrying node's id in the world file, which attach.anchor must equal when present.
 * `fetchLimitMs` (default FETCH_LIMIT_MS) limits the carrier fetch. Never rejects.
 */
export async function readCarrierManifest({ manifestUrl, nodeId, fetch, now = () => Date.now(), verify, fetchLimitMs }) {
  const limitMs = Number.isFinite(fetchLimitMs) && fetchLimitMs > 0 ? fetchLimitMs : FETCH_LIMIT_MS;
  let manifest;
  try {
    const text = await withinLimit(async (signal) => {
      // No redirect is followed: a carrier is read at world load, and a redirect could take that request to a maker.
      const response = await fetch(manifestUrl, { signal, redirect: "error" });
      if (!response || !response.ok) throw new Error(`HTTP ${response && response.status}`);
      return response.text();
    }, limitMs);
    manifest = parseIJson(text);
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
  const fingerprint = await keyFingerprint(signed.key);
  return { ok: true, extensions: facets.map((facet) => readFacet(facet, { manifest, manifestUrl, key: signed.key, fingerprint, nodeId, address: statusAddress(manifest, facet) })) };
}

export default { readCarrierManifest, isExtensionFacet, keyFingerprint, withinLimit, FETCH_LIMIT_MS };
