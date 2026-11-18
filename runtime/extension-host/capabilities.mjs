// The capability tokens of the extension profile, and the one question the host asks of a grant: does it allow this
// token? Default deny: a token is allowed only when the grant names it exactly. A refused call returns a negative
// error to the extension, never 0.

/** Tokens confined to the attachment that opened them; released when it closes. */
export const ATTACHMENT_TOKENS = Object.freeze([
  "ue.console.log",
  "ue.data.read",
  "ue.scene.nodes",
  "ue.scene.read",
  "ue.clock.read",
  "ue.clock.timer",
]);

/** Tokens that need a user prompt before any grant names them. */
export const PROMPTED_TOKENS = Object.freeze([
  "ue.ui.panel",
  "ue.input.pointer",
  "ue.storage.local",
]);

/** Token families: one origin per network grant, one device action per actuation grant, one sensor signal per grant. */
export const TOKEN_FAMILIES = Object.freeze({
  "ue.network.fetch": /^ue\.network\.fetch:https?:\/\/[^/\s]+$/,
  "ue.device.actuate": /^ue\.device\.actuate\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/,
  sensor: /^sensor\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/,
});

/** Negative results a refused or failed host call returns. */
export const ERRORS = Object.freeze({
  DENIED: -13n,
  FAULT: -14n,
  INVALID: -22n,
  UNKNOWN: -38n,
});

const NAMED = new Set([...ATTACHMENT_TOKENS, ...PROMPTED_TOKENS]);
const FETCH_PREFIX = "ue.network.fetch:";

/**
 * The origin of an http(s) URL in the RFC 6454 ASCII form (scheme, lowercase host, the port only when it is not the
 * scheme's default), or null for anything else, including a URL with a user name or password.
 */
export function originOf(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
  return parsed.origin;
}

/** The ue.network.fetch token a request to `url` needs, or null when `url` is not an http(s) URL. */
export function fetchToken(url) {
  const origin = originOf(url);
  return origin === null ? null : `${FETCH_PREFIX}${origin}`;
}

/**
 * The placement key of one declaration at one world node: the world URL without query or fragment, the node id,
 * module.integrity and attach. It keys grants and storage; a new hash or a new attachment is a new placement.
 */
export function placementKey({ world = "", node = "", integrity = "", attach = null } = {}) {
  return JSON.stringify([String(world).replace(/[?#].*$/s, ""), String(node), String(integrity), attach === undefined ? null : attach]);
}

/** True when `token` is a well-formed token of the profile (named, or a member of a family). */
export function isToken(token) {
  if (typeof token !== "string") return false;
  if (token.startsWith(FETCH_PREFIX)) return TOKEN_FAMILIES["ue.network.fetch"].test(token) && originOf(token.slice(FETCH_PREFIX.length)) === token.slice(FETCH_PREFIX.length);
  return NAMED.has(token) || Object.values(TOKEN_FAMILIES).some((pattern) => pattern.test(token));
}

/** The set of well-formed tokens a grant names; anything else in it grants nothing. */
export function grantTokens(grant) {
  const list = grant instanceof Set ? [...grant] : Array.isArray(grant) ? grant : [];
  return new Set(list.filter(isToken));
}

/**
 * Does `grant` allow `token`? Exact match only: no wildcards, no prefixes, no case folding. A network token names one
 * origin in its normalized form (see originOf), and a grant token that is not in that form grants nothing.
 */
export function allows(grant, token) {
  if (!isToken(token)) return false;
  const tokens = grant instanceof Set ? grant : grantTokens(grant);
  return tokens.has(token);
}
