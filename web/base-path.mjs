/*
 * the ONE browser-side source of truth for the public base path and the world servers' origin.
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
 * SEPARATE SERVER ORIGIN: a static copy of web/ served apart from the world servers (another host,
 * as plain files) is told where they are by window.__OSL_SERVER_ORIGIN__ ("https://lab.example"),
 * set before any other script by the external osl-app-config.js its build writes. Every URL the
 * world servers answer (/worlds.json, /api/{key}/…, the streams, the /w/{key}/ pages) then goes to
 * that origin's root, through withServer()/apiBase()/serverRootUrl(); the page's own files
 * (/assets/…, the vendored engines) stay beneath BASE_PATH on this page's origin. Unset,
 * SERVER_ORIGIN === "" and each server helper is exactly withBase(), so nothing changes.
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

/**
 * Pure. Returns "" for unset/invalid, else the origin "http(s)://host[:port]" of a bare http or https
 * origin. Anything with a path, query, fragment or credentials is invalid: fail closed to this page's origin.
 */
export function normalizeServerOrigin(raw)
{
  const s = String(raw == null ? "" : raw).trim();
  if (s === "") return "";
  let url;
  try { url = new URL(s); } catch { return ""; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return "";
  return url.origin;
}

/**
 * A ROOT-ABSOLUTE world-server path, for an explicit server origin and base. With no server origin this is
 * applyBase(base, p), unchanged. With one, the path goes to that origin's root (the world servers' paths are not
 * beneath this page's base). Pass-throughs as applyBase: a non-"/" value, and a scheme-relative "//…" value.
 */
export function applyServer(origin, base, p)
{
  const server = normalizeServerOrigin(origin);
  const value = String(p == null ? "" : p);
  if (!server) return applyBase(base, value);
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  return server + value;
}

function readInjected(name)
{
  const g = typeof globalThis !== "undefined" ? globalThis : {};
  return typeof g[name] === "string" ? g[name] : "";
}

/** The deploy-time prefix for THIS document. "" in root mode. */
export const BASE_PATH = normalizeBasePath(readInjected("__OSL_BASE_PATH__"));

/** The world servers' origin when it is not this page's. "" when they share this page's origin. */
export const SERVER_ORIGIN = normalizeServerOrigin(readInjected("__OSL_SERVER_ORIGIN__"));

/** Prefix a root-absolute same-origin path with the active BASE_PATH. Identity in root mode. */
export function withBase(p)
{
  return applyBase(BASE_PATH, p);
}

/** A root-absolute path the world servers answer: at SERVER_ORIGIN when set, else withBase(p). */
export function withServer(p)
{
  return applyServer(SERVER_ORIGIN, BASE_PATH, p);
}

/** The proxy base for a world endpoint key: beneath the active prefix, or at SERVER_ORIGIN when set. */
export function apiBase(endpointKey)
{
  return withServer("/api/" + endpointKey);
}

/** The absolute URL of the world servers' root ("…/"): SERVER_ORIGIN when set, else this page's origin and prefix. */
export function serverRootUrl(locationLike = globalThis.location, origin = SERVER_ORIGIN, base = BASE_PATH)
{
  const server = normalizeServerOrigin(origin);
  return server ? `${server}/` : `${locationLike.origin}${normalizeBasePath(base)}/`;
}

export default { BASE_PATH, SERVER_ORIGIN, withBase, withServer, apiBase, serverRootUrl, applyBase, applyServer, normalizeBasePath, normalizeServerOrigin };
