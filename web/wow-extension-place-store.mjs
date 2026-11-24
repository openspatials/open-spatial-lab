// web/wow-extension-place-store.mjs
//
// What a place (the origin the world file is served from) gives the extensions of its world, so that selecting a
// glance tells no maker and no issuer what the visitor looked at. The world file declares both, at world level, in its
// `webofworlds_extension`:
//
//   - The place store, `extension_store`: { url }, a folder on the world file's own origin. It holds copies of the
//     world's extension modules, each named sha256-<digest in base64url, no padding>.wasm after its module.integrity.
//     With a store, a module comes from the store. The host still checks every module's SHA-256 against
//     module.integrity: a copy with other bytes is refused at stage `integrity` and is never replaced by the maker's
//     (that would hide the tampering and tell the maker). With no copy (HTTP 404) the module comes from the maker's
//     address at selection, as in a world with no store.
//   - Advance fetch: after world load every store copy the world's extensions name is fetched, in the order they
//     appear, up to ADVANCE_FETCH_CAP_BYTES in all. The bytes stay in memory for the page session, so selecting a
//     glance then makes no request at all. The first copy that would pass the cap is not kept and the advance fetch
//     stops there; that copy and the rest are fetched from the store at selection.
//   - The withdrawn list, `extension_status_list`: { url } on the world file's own origin, a JSON file { checkedAt,
//     entries: [{ "@id": <carrier manifest @id>, status: "revoked" | "suspended" }] }, fetched once at world load. A
//     carrier listed is refused at stage `status`; a carrier not listed, a world with no list, or a list that does not
//     load gives revocationStatus "unchecked". No issuer is asked.
//
// A store or a list on another origin is refused at stage `declaration`: reading it would be a request to someone other
// than the place. The place compiles the list, so a place could leave a withdrawn carrier out; a second source (the
// extension's own signed status) is later work.
//
// Fetching code by its hash is the kind of work the Assets part owns at milestone M4; it is kept in this one file so it
// can move there. PURE of the DOM and of three: fetch is injected.
import { withinLimit, FETCH_LIMIT_MS } from "./wow-extension-manifest-adapter.mjs";
import { REASON_UNCHECKED } from "./manifest/statusref-resolution.mjs";

/** The most bytes advance fetch keeps for one world. */
export const ADVANCE_FETCH_CAP_BYTES = 8 * 1024 * 1024;
/** The statuses of the withdrawn list; a carrier listed with either is refused. */
export const WITHDRAWN_STATUSES = Object.freeze(["revoked", "suspended"]);

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
// The store copies of this page session, by their address.
const PAGE_COPIES = new Map();

/** storeCopyName("sha256-<base64>") -> "sha256-<base64url, no padding>.wasm", or null for another form. */
export function storeCopyName(integrity) {
  const match = /^sha256-([A-Za-z0-9+/]{43})=$/.exec(String(integrity || ""));
  return match ? `sha256-${match[1].replace(/\+/g, "-").replace(/\//g, "_")}.wasm` : null;
}

/** One world-level member, { url }: its address, resolved against the world file and on its origin. */
function placeAddress(name, value, worldUrl, folder) {
  if (value === undefined || value === null) return { url: null };
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "url") || typeof value.url !== "string" || !value.url) {
    return { refused: `${name} must be { url: <non-empty string> }` };
  }
  let url;
  try { url = new URL(folder && !value.url.endsWith("/") ? `${value.url}/` : value.url, worldUrl).href; } catch { return { refused: `${name}.url ${JSON.stringify(value.url)} is not an address` }; }
  if (originOf(url) !== originOf(worldUrl)) return { refused: `${name} ${url} is not on the world file's origin ${originOf(worldUrl)}; a place serves its store and its list itself` };
  return { url };
}

/**
 * readPlaceDeclarations(place, worldUrl) -> { ok: true, storeUrl, listUrl } (null where the world declares none) or
 * { ok: false, detail }. `place` is the world file's world-level `webofworlds_extension` members.
 */
export function readPlaceDeclarations(place, worldUrl) {
  const members = isPlainObject(place) ? place : {};
  const store = placeAddress("extension_store", members.extension_store, worldUrl, true);
  if (store.refused) return { ok: false, detail: store.refused };
  const list = placeAddress("extension_status_list", members.extension_status_list, worldUrl, false);
  if (list.refused) return { ok: false, detail: list.refused };
  return { ok: true, storeUrl: store.url, listUrl: list.url };
}

/**
 * createPlaceStore({ storeUrl, fetch, capBytes?, copies? }) -> { prefetch(integrities), codeOf(integrity) }.
 * prefetch(integrities) -> Promise<{ kept, bytes, stopped }>: the advance fetch, in order, up to capBytes
 * (ADVANCE_FETCH_CAP_BYTES). codeOf(integrity) -> Promise<{ source: "place", url, bytes } | { source: "maker" } |
 * { error, url }>: the module's copy, from memory when advance fetch kept it, otherwise from the store; "maker" when the
 * store has no copy (HTTP 404). Any other failure is an error, never the maker. `copies` (default: one map for the page
 * session) keeps the bytes. No request follows a redirect: a redirect could take it to a maker.
 */
export function createPlaceStore({ storeUrl, fetch, capBytes = ADVANCE_FETCH_CAP_BYTES, copies = PAGE_COPIES }) {
  const cap = Number.isFinite(capBytes) && capBytes >= 0 ? capBytes : ADVANCE_FETCH_CAP_BYTES;
  const absent = new Set();
  const inflight = new Map();
  const urlOf = (integrity) => {
    const name = storeCopyName(integrity);
    return name ? new URL(name, storeUrl).href : null;
  };
  // One GET of a copy: { bytes } | { absent: true } | { error }. One request per address at a time.
  function fetchCopy(url) {
    if (!inflight.has(url)) {
      inflight.set(url, (async () => {
        try {
          const response = await fetch(url, { redirect: "error" });
          if (response && response.status === 404) return { absent: true };
          if (!response || !response.ok) return { error: `HTTP ${response && response.status}` };
          return { bytes: new Uint8Array(await response.arrayBuffer()) };
        } catch (error) {
          return { error: oneLine(error) };
        }
      })().finally(() => inflight.delete(url)));
    }
    return inflight.get(url);
  }

  async function prefetch(integrities) {
    let total = 0, kept = 0, stopped = false;
    for (const url of [...new Set((integrities || []).map(urlOf).filter(Boolean))]) {
      if (absent.has(url)) continue;
      if (copies.has(url)) {
        total += copies.get(url).length;
        continue;
      }
      if (total >= cap) { stopped = true; break; }
      const got = await fetchCopy(url);
      if (got.absent) { absent.add(url); continue; }
      if (!got.bytes) continue;
      if (total + got.bytes.length > cap) { stopped = true; break; }
      if (!copies.has(url)) copies.set(url, got.bytes);
      total += got.bytes.length;
      kept += 1;
    }
    return { kept, bytes: total, stopped };
  }

  async function codeOf(integrity) {
    const url = urlOf(integrity);
    if (!url) return { error: `no store name for module.integrity ${JSON.stringify(integrity)}`, url: storeUrl };
    if (copies.has(url)) return { source: "place", url, bytes: copies.get(url) };
    if (absent.has(url)) return { source: "maker" };
    const got = await fetchCopy(url);
    if (got.absent) {
      absent.add(url);
      return { source: "maker" };
    }
    if (!got.bytes) return { error: got.error, url };
    if (!copies.has(url)) copies.set(url, got.bytes);
    return { source: "place", url, bytes: copies.get(url) };
  }

  return { prefetch, codeOf };
}

/**
 * readWithdrawnList({ listUrl, fetch, limitMs? }) -> Promise<{ ok: true, checkedAt, entries: Map<@id, status> } |
 * { ok: false, detail }>. Fetched once at world load, within limitMs (FETCH_LIMIT_MS), with no redirect. A list that does
 * not answer, answers with an error, or is not { checkedAt: <date>, entries: [{ "@id", status }] } with each status
 * revoked or suspended, did not load. Never rejects.
 */
export async function readWithdrawnList({ listUrl, fetch, limitMs = FETCH_LIMIT_MS }) {
  let list;
  try {
    const text = await withinLimit(async (signal) => {
      const response = await fetch(listUrl, { signal, redirect: "error" });
      if (!response || !response.ok) throw new Error(`HTTP ${response && response.status}`);
      return response.text();
    }, Number.isFinite(limitMs) && limitMs > 0 ? limitMs : FETCH_LIMIT_MS);
    list = JSON.parse(text);
  } catch (error) {
    return { ok: false, detail: oneLine(error) };
  }
  if (!isPlainObject(list) || typeof list.checkedAt !== "string" || !Number.isFinite(Date.parse(list.checkedAt)) || !Array.isArray(list.entries)) {
    return { ok: false, detail: "the list is not { checkedAt: <date>, entries: [...] }" };
  }
  const entries = new Map();
  for (const [index, entry] of list.entries.entries()) {
    if (!isPlainObject(entry) || typeof entry["@id"] !== "string" || !entry["@id"] || !WITHDRAWN_STATUSES.includes(entry.status)) {
      return { ok: false, detail: `entries[${index}] is not { "@id", status: revoked | suspended }` };
    }
    entries.set(entry["@id"], entry.status);
  }
  return { ok: true, checkedAt: list.checkedAt, entries };
}

/**
 * withdrawnStatusOf(list, manifestId) -> { revocationStatus, reason }: "revoked" or "suspended" for a carrier the list
 * names, otherwise "unchecked". `list` is readWithdrawnList's answer, or null for a world with no list.
 */
export function withdrawnStatusOf(list, manifestId) {
  if (!list) return { revocationStatus: "unchecked", reason: `${REASON_UNCHECKED}: this place has no withdrawn list` };
  if (!list.ok) return { revocationStatus: "unchecked", reason: `${REASON_UNCHECKED}: the place's withdrawn list did not load (${list.detail})` };
  const status = list.entries.get(manifestId);
  if (status) return { revocationStatus: status, reason: `listed ${status} on the place's withdrawn list of ${list.checkedAt}` };
  return { revocationStatus: "unchecked", reason: `${REASON_UNCHECKED}: not on the place's withdrawn list of ${list.checkedAt}` };
}

export default { ADVANCE_FETCH_CAP_BYTES, WITHDRAWN_STATUSES, storeCopyName, readPlaceDeclarations, createPlaceStore, readWithdrawnList, withdrawnStatusOf };
