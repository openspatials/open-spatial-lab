/*
 * the ONE browser-side source of truth for the public base path.
 *
 * ROOT MODE (default): BASE_PATH === "" and every helper is an identity, so every URL is
 * byte-for-byte identical to the pre-task root behaviour. Nothing is injected, nothing changes.
 *
 * SUBPATH MODE: the integrated host (src/serve.js) injects
 *     <script>window.__OSL_BASE_PATH__="/open-spatial-lab";</script>
 * into the served HTML <head>, BEFORE the deferred module graph evaluates. Every same-origin
 * ROOT-ABSOLUTE URL literal ("/api/…", "/assets/…", "/runtime-assets/…", the same-origin
 * WebSocket path) is routed through withBase()/apiBase() here so it resolves beneath the prefix.
 *
 * The literal prefix "/open-spatial-lab" appears in ZERO feature modules — it lives only in the
 * deployment config and this file's injected value. normalizeBasePath()/applyBase() are pure and
 * mirror src/public-base-path.js (asserted equal by the base-path check).
 */

'use strict';

const VALID_BASE_PATH = /^(\/[A-Za-z0-9][A-Za-z0-9._~-]*)+$/;

/** Pure, global-free. Returns "" for root/invalid, else "/seg[/seg…]" with no trailing slash. */
export function normalizeBasePath(raw)
{
  const s = String(raw == null ? "" : raw).trim();
  if (s === "" || s === "/") return "";
  const stripped = s.replace(/\/+$/, "");
  if (!VALID_BASE_PATH.test(stripped)) return ""; // fail closed to root
  return stripped;
}

/**
 * Prefix a ROOT-ABSOLUTE path with an explicit base. Pass-throughs (unchanged):
 *   - a falsy/empty base  -> identity (root mode)
 *   - a non-"/" value     -> scheme-relative, absolute-URL, or pseudo-scheme ("parametric://…")
 *   - an already-prefixed value ("/open-spatial-lab" or "/open-spatial-lab/…")
 */
export function applyBase(base, p)
{
  const prefix = normalizeBasePath(base);
  const value = String(p == null ? "" : p);
  if (!prefix) return value;
  if (!value.startsWith("/")) return value;
  if (value === prefix || value.startsWith(prefix + "/")) return value;
  return prefix + value;
}

function readInjectedBase()
{
  const g = typeof globalThis !== "undefined" ? globalThis : {};
  return typeof g.__OSL_BASE_PATH__ === "string" ? g.__OSL_BASE_PATH__ : "";
}

/** The deploy-time prefix for THIS document. "" in root mode. */
export const BASE_PATH = normalizeBasePath(readInjectedBase());

/** Prefix a root-absolute same-origin path with the active BASE_PATH. Identity in root mode. */
export function withBase(p)
{
  return applyBase(BASE_PATH, p);
}

/** The same-origin proxy base for a world endpoint key, beneath the active prefix. */
export function apiBase(endpointKey)
{
  return withBase("/api/" + endpointKey);
}

export default { BASE_PATH, withBase, apiBase, applyBase, normalizeBasePath };
