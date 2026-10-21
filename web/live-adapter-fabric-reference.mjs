/*
 * resolve a portal attachment node's fabric sReference to
 * a SAME-ORIGIN proxy path beneath the active public base path.
 *
 * A portal's Resource.sReference is authored either as a loopback backend URL
 * (http://127.0.0.1:1815x/…, the pre-proxy form) OR as an already same-origin
 * ROOT-ABSOLUTE proxy path (/api/{a,b,lobby,airport}/fabric.json). BOTH must
 * resolve BENEATH the deploy-time public base path so the browser fetches
 * /open-spatial-lab/api/a/fabric.json in subpath mode instead of the
 * un-prefixed /api/a/fabric.json (which 404s at the origin root — the live
 * "world temporarily unavailable" child-fabric miss). In root mode every branch
 * is byte-for-byte identity.
 *
 * WHY THIS LIVES IN ITS OWN .mjs: sReference is MANIFEST DATA, not a URL literal
 * in code, so literal-sweep never saw this seam. This function is pure
 * and Node-importable (the base is passed in, not read from an injected global)
 * so the base-path check unit-proves BOTH modes in one process — the
 * coverage the check previously lacked.
 */

import { applyBase } from "./base-path.mjs";

// Loopback backend origin -> same-origin proxy endpoint key. Mirrors the
// ENDPOINTS[*].backend_base_url map in live-adapter.js (18151→a … 18154→airport).
const LOOPBACK_ORIGIN_TO_ENDPOINT_KEY = Object.freeze([
  [/^https?:\/\/(?:127\.0\.0\.1|localhost):18151/i, "a"],
  [/^https?:\/\/(?:127\.0\.0\.1|localhost):18152/i, "b"],
  [/^https?:\/\/(?:127\.0\.0\.1|localhost):18153/i, "lobby"],
  [/^https?:\/\/(?:127\.0\.0\.1|localhost):18154/i, "airport"],
]);

/**
 * @param {string} base active public base path ("" root, "/open-spatial-lab" subpath).
 * @param {*}      ref  the authored sReference (string) or null/undefined.
 * @returns {string|null} the same-origin proxy path beneath `base`, a foreign
 *   absolute URL untouched, a relative ref untouched, or null for a non-string.
 */
export function resolveFabricReference(base, ref) {
  if (!ref || typeof ref !== "string") return null;
  if (/^https?:\/\//i.test(ref)) {
    for (const [origin, key] of LOOPBACK_ORIGIN_TO_ENDPOINT_KEY) {
      if (origin.test(ref)) return ref.replace(origin, applyBase(base, "/api/" + key));
    }
    // A foreign absolute URL (some other origin) is cross-origin by intent;
    // leave it untouched (applyBase is a no-op for non-"/" values anyway).
    return ref;
  }
  // Root-absolute same-origin path (/api/a/fabric.json, /fabric.json, …): prefix
  // it beneath the base. applyBase is identity in root mode, idempotent for an
  // already-prefixed value, and a pass-through for a relative (non-"/") ref.
  return applyBase(base, ref);
}

export default { resolveFabricReference };
