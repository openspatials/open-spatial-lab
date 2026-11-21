// web/wow-extension-manifest-adapter.mjs
//
// The second way a world node declares an extension: `webofworlds_extension.universal_extension_manifests` points to
// signed carrier manifests (Universal Manifest v0.6), each extension a facet whose @type includes um:Facet and
// osl:ExtensionFacet and whose entity @type includes osl:Extension (docs/universal-extensions/UM-PROFILE-PROPOSAL.md,
// sections 2.1 and 2.4). This adapter turns one carrier into the declarations the mount pass already runs.
//
// The order: fetch the manifest (stage `manifest-fetch`); verify the signature over the whole manifest, with the key in
// signature.publicKeySpkiB64 (stage `signature`); check issuedAt and expiresAt against the clock (stage `validity`);
// then, per extension facet, resolve its status and read it. The status address is the extension entity's statusRef,
// which the signature covers (profile section 2.1); signature.statusRef is outside the signing input, so it is never
// used: present and not equal to entity.statusRef (or present without one), the extension is refused at stage `status`.
// The status is resolved with the Lab's statusRef code (web/manifest/statusref-resolution.mjs, evaluateStatusRef); a
// `revoked` or `suspended` extension is refused (stage `status`); only then is the facet read (stage `facet`). Nothing
// names a module before the signature and the status pass, so the mount fetches no module of an extension that fails.
// An extension with no statusRef, or whose status cannot be read (endpoint down or silent, offline, not https,
// malformed answer), runs, and its record carries revocationStatus "unchecked" with the reason.
//
// The carrier fetch and each status fetch stop after FETCH_LIMIT_MS (10 s; `fetchLimitMs` overrides it): a carrier
// that does not answer in time is refused at `manifest-fetch`, a status that does not answer in time is unchecked. Each
// is given an abort signal (fetch(url, { signal })), which is aborted at the limit, so the request does not stay open.
//
// fetch, the clock, the verifier and the status transport are injected. The verifier is the Lab's Signature Profile A verifier
// (web/signing/um-signature-profile-a.mjs, verifyManifestProfileA), which the mount pass gives by default.
import { validateExtensionDeclaration } from "./wow-scene.mjs";
import { parseIJson } from "./signing/ijson.mjs";
import { evaluateStatusRef, REASON_UNCHECKED } from "./manifest/statusref-resolution.mjs";

const MIB = 1024 * 1024;
const ATTACH_KINDS = ["world-node", "app-panel", "device", "person"];
const LIMITS = ["memoryMiB", "initMs", "eventMs", "timers"];
const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const typesOf = (value) => (Array.isArray(value) ? value : [value]);
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const refusal = (stage, detail) => ({ ok: false, stage, detail });
/** Statuses that refuse an extension. Anything else that is not "active" is "unchecked" and runs. */
const REFUSED_STATUSES = new Set(["revoked", "suspended"]);
/** The time limit of one fetch (the carrier, or one status endpoint), in milliseconds. */
export const FETCH_LIMIT_MS = 10000;

/** work(signal) settled within ms, or rejected with "no answer within <ms> ms"; at the limit the signal is aborted. */
function withinLimit(work, ms) {
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
 * fetchStatusTransport(fetch) -> async (statusRef, { signal }) => { httpStatus, body } | null: GETs the status endpoint
 * with the injected fetch and the abort signal. A network failure or an abort gives null; a body that is not JSON gives
 * body null (resolved as malformed).
 */
export function fetchStatusTransport(fetch) {
  return async (statusRef, { signal } = {}) => {
    try {
      const response = await fetch(statusRef, { signal });
      if (!response) return null;
      let body = null;
      try { body = JSON.parse(await response.text()); } catch { body = null; }
      return { httpStatus: response.status, body };
    } catch {
      return null;
    }
  };
}

/**
 * One extension's status: { revocationStatus, reason } or { refused: detail }. The address is the signed
 * entity.statusRef; an unsigned signature.statusRef that differs from it (or stands alone) is tampering and refuses.
 * evaluateStatusRef takes a synchronous transport, so the (asynchronous) answer is read first, within the time limit,
 * and handed to it; no answer in time is resolved as no answer. The spec-default policy is used only for its
 * resolution: this adapter refuses on revocationStatus itself (revoked and suspended refuse; unchecked runs).
 * `answers` keeps one request per address within a carrier.
 */
async function extensionStatus(manifest, facet, { fetch, statusTransport, limitMs, answers }) {
  const signature = isPlainObject(manifest.signature) ? manifest.signature : {};
  const statusRef = facet.entity.statusRef;
  const unsigned = signature.statusRef;
  if (unsigned !== undefined && unsigned !== statusRef) {
    return { refused: `signature.statusRef ${JSON.stringify(unsigned)} is not the signed entity.statusRef ${JSON.stringify(statusRef === undefined ? null : statusRef)}; an unsigned status address is never used` };
  }
  if (statusRef === undefined) return { revocationStatus: "unchecked", reason: `${REASON_UNCHECKED}: the extension entity has no statusRef` };
  const transport = statusTransport || fetchStatusTransport(fetch);
  // Only an https statusRef is requested; evaluateStatusRef gives any other "insecure-transport" without a request.
  let answer = null;
  if (typeof statusRef === "string" && /^https:\/\//i.test(statusRef)) {
    if (!answers.has(statusRef)) answers.set(statusRef, withinLimit((signal) => Promise.resolve(transport(statusRef, { signal })), limitMs).catch(() => null));
    answer = await answers.get(statusRef);
  }
  const checked = evaluateStatusRef({
    statusRef, manifestId: manifest["@id"], revocationCursor: signature.revocationCursor,
    transport: () => answer, policy: "spec-default",
  });
  return { revocationStatus: checked.revocationStatus, reason: checked.reason };
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

/** One extension facet -> { ok: true, effective, carrier } or { ok: false, stage: "facet", detail }. */
function readFacet(facet, { manifest, manifestUrl, key, fingerprint, nodeId, status }) {
  if (status.refused) return refusal("status", `${facet["@id"] || "facet"}: ${status.refused}`);
  if (REFUSED_STATUSES.has(status.revocationStatus)) return refusal("status", `${facet["@id"] || "facet"}: the status is ${status.revocationStatus} (${facet.entity.statusRef})`);
  const revocation = { revocationStatus: status.revocationStatus, revocationReason: status.reason };
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
      subject: manifest.subject, key, fingerprint, attach: attachment, manifest_url: manifestUrl, facet_id: facet["@id"] || null,
      ...revocation,
      // The placement of profile section 2.4 (with module.integrity, which the mount adds): never the @ids.
      placement: JSON.stringify([manifest.subject, key, attachment]),
    },
  };
}

/**
 * readCarrierManifest({ manifestUrl, nodeId, fetch, now, verify, statusTransport, fetchLimitMs }) -> Promise<{ ok: true,
 * extensions: [...] } | { ok: false, stage, detail }>. Each extension is { ok: true, effective, carrier } or
 * { ok: false, stage: "status" | "facet", detail }; carrier.revocationStatus is "active" or "unchecked" (with
 * carrier.revocationReason). `nodeId` is the carrying node's id in the world file, which attach.anchor must equal when
 * present. `statusTransport` (statusRef, { signal }) => Promise<{ httpStatus, body } | null> reads the status endpoint (default:
 * fetchStatusTransport(fetch)). `fetchLimitMs` (default FETCH_LIMIT_MS) limits the carrier fetch and each status
 * fetch. Never rejects.
 */
export async function readCarrierManifest({ manifestUrl, nodeId, fetch, now = () => Date.now(), verify, statusTransport, fetchLimitMs }) {
  const limitMs = Number.isFinite(fetchLimitMs) && fetchLimitMs > 0 ? fetchLimitMs : FETCH_LIMIT_MS;
  let manifest;
  try {
    const text = await withinLimit(async (signal) => {
      const response = await fetch(manifestUrl, { signal });
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
  const answers = new Map();
  const statuses = await Promise.all(facets.map((facet) => extensionStatus(manifest, facet, { fetch, statusTransport, limitMs, answers })));
  const fingerprint = await keyFingerprint(signed.key);
  return { ok: true, extensions: facets.map((facet, at) => readFacet(facet, { manifest, manifestUrl, key: signed.key, fingerprint, nodeId, status: statuses[at] })) };
}

export default { readCarrierManifest, isExtensionFacet, keyFingerprint, fetchStatusTransport, FETCH_LIMIT_MS };
