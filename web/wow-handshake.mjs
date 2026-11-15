/*
 * The visitor's side of the identity handshake (iteration 5, stage A). Browser and Node.
 *
 * A world states who it is, the claims it asks a visitor for and the credential types it issues, in its
 * World resource (`identity`, `claims`, `issues`). Before it discloses anything, the visitor's agent:
 *
 *   1. reads the World resource from the base URL it is about to post to;
 *   2. checks that the World names that same base URL as its identity (otherwise it sends nothing);
 *   3. picks, from what the visitor holds, only the claims the World asks for, minus any the visitor
 *      withholds;
 *   4. makes a key for this world and this visit; its did:key is the pointer the world receives, so two
 *      worlds never receive the same pointer, signature or proof value;
 *   5. signs a manifest that carries only those claims (the integrity check), and signs a holder proof
 *      over its digest, a fresh nonce and the world's base URL as the audience (the holder proof);
 *   6. posts both in the body of `POST {base}wow/user`, with the visitor's pilot statement (`pilot`: human, agent
 *      or hybrid; every join carries one, and the agent sends nothing when the visitor states none), and returns the
 *      world's answer: the outcome (proceed, proceed-in-part or deny) and the claims satisfied and not satisfied.
 *
 * The world copies the pilot statement onto the User it makes (User.pilot). It is the visitor's statement, not proof
 * of who is at the controls. A client shows a user whose pilot is hybrid as an agent (pilotShownAs, userLabel).
 *
 * Nothing goes in a URL. The manifest and the holder proof are the lab's own shapes, labelled as a
 * proposal: the World API gives their format by reference, and no manifest format is chosen here.
 * Signing reuses web/signing/ (Ed25519 RFC 8032, JCS RFC 8785, did:key).
 */

import { attachSignatureProfileA, generateKeyPair, publicKeyToDidKey, canonicalize, bytesToBase64Url } from "./signing/index.mjs";

export const CLAIM_NAMES = Object.freeze(["avatar", "display_name", "preferences", "age"]);
export const OUTCOME = Object.freeze({ PROCEED: "proceed", PART: "proceed-in-part", DENY: "deny" });
export const TRUST = Object.freeze({ SELF: "self-asserted", ISSUER: "issuer-verified" });
export const MANIFEST_TYPE = "osl-visit-manifest";
export const HOLDER_PROOF_TYPE = "osl-holder-proof";
export const CREDENTIAL_TYPE = "osl-claim-credential";
export const LABEL = "lab proposal; not a conformance claim for any manifest format";
/** The pilot statements a join carries (User.pilot): who the visitor states is at the controls. */
export const PILOTS = Object.freeze(["human", "agent", "hybrid"]);

/** How a client shows a user's pilot: "agent" for agent and hybrid, "human" for human, null when none is stated. */
export function pilotShownAs(pilot) {
  return pilot === "agent" || pilot === "hybrid" ? "agent" : pilot === "human" ? "human" : null;
}

/** A user's label, wherever a client shows another user's name: the name and how its pilot is shown, e.g. "Ada (agent)". */
export function userLabel(user) {
  const name = user && typeof user.name === "string" && user.name.trim() ? user.name : `user ${user && user.id}`;
  return `${name} (${pilotShownAs(user && user.pilot) || "pilot not stated"})`;
}

/** The base URL of a world, from any of its resource URLs (or the base itself): up to and with the `/` before `wow/`. */
export function baseOf(url) {
  const u = new URL(url);
  const at = u.pathname.indexOf("/wow/");
  if (at !== -1) u.pathname = u.pathname.slice(0, at + 1);
  else if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.search = "";
  u.hash = "";
  return u.href;
}

/** Read a world's World resource. */
export async function readWorld(base, { fetch: f = globalThis.fetch } = {}) {
  const r = await f(new URL("wow/world", base).href, { headers: { Accept: "application/wow+json, application/json" } });
  if (!r.ok) throw new Error(`the World resource answered ${r.status}`);
  return r.json();
}

/**
 * Before disclosing anything: does the World resource name, as its identity, the base URL the agent is
 * about to post to? It must state its claims too. Returns { ok, reason }.
 */
export function checkCounterpart(world, base) {
  const stated = world && world.identity && typeof world.identity.base === "string" ? world.identity.base : null;
  if (!stated) return { ok: false, reason: "the world states no identity (identity.base)" };
  let same = false;
  try { same = baseOf(stated) === baseOf(base); } catch { same = false; }
  if (!same) return { ok: false, reason: `the world names ${stated} as its base URL, not ${baseOf(base)}` };
  if (!Array.isArray(world.claims)) return { ok: false, reason: "the world states no claims list" };
  if (!Array.isArray(world.issues)) return { ok: false, reason: "the world states no issues list" };
  return { ok: true, reason: null };
}

/** What the world asks for, normalised: [{ name, required, issuers? }]. */
export function askedOf(world) {
  return (Array.isArray(world && world.claims) ? world.claims : [])
    .filter((c) => c && typeof c.name === "string")
    .map((c) => ({ name: c.name, required: c.required === true, ...(Array.isArray(c.issuers) ? { issuers: c.issuers.slice() } : {}) }));
}

/**
 * The disclosure plan: of the claims the world asks for, those the visitor holds and does not withhold.
 * Claims the world does not ask for are never in it (UC04-R02).
 */
export function planDisclosure(asked, wallet, { withhold = [] } = {}) {
  const held = (wallet && wallet.claims) || {};
  const send = [];
  const withheld = [];
  const missing = [];
  for (const claim of asked) {
    if (withhold.includes(claim.name)) withheld.push(claim.name);
    else if (Object.prototype.hasOwnProperty.call(held, claim.name)) send.push(claim.name);
    else missing.push(claim.name);
  }
  return { send, withheld, missing };
}

const subtle = () => globalThis.crypto.subtle;
async function sha256(bytes) { return new Uint8Array(await subtle().digest("SHA-256", bytes)); }

/** sha-256 of the manifest's JCS bytes, base64url: what the holder proof signs over. */
export async function manifestDigest(manifest) {
  return "sha-256:" + bytesToBase64Url(await sha256(canonicalize(manifest)));
}

/** A fresh key for one world and one visit. Its did:key is the pointer that world receives. */
export async function visitKey() {
  const pair = await generateKeyPair();
  return { privateKey: pair.privateKey, did: publicKeyToDidKey(pair.rawPublicKey) };
}

function nonce() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** A lab issuer signs one claim for one subject (a credential bound to that subject's key). */
export async function issueCredential(issuer, { subject, claim, value, issued = new Date().toISOString() }) {
  const body = { type: CREDENTIAL_TYPE, issuer: issuer.did, subject, claim, value, issued };
  return attachSignatureProfileA(body, issuer.privateKey, { created: null });
}

/**
 * The manifest and holder proof for one world and one visit.
 *   values       { name: value } of the claims to send, and nothing else
 *   credentials  { name: issuer } for claims a lab issuer signs for this visit's key (optional)
 *   pilot        the visitor's pilot statement: human, agent or hybrid (required; sent beside the manifest)
 */
export async function presentation({ values, key, audience, credentials = {}, created = new Date().toISOString(), pilot }) {
  if (!PILOTS.includes(pilot)) throw new TypeError(`a join carries a pilot statement (human, agent or hybrid), not ${JSON.stringify(pilot)}`);
  const claims = {};
  for (const [name, value] of Object.entries(values)) {
    claims[name] = { value };
    if (credentials[name]) claims[name].credential = await issueCredential(credentials[name], { subject: key.did, claim: name, value });
  }
  const manifest = await attachSignatureProfileA({ type: MANIFEST_TYPE, label: LABEL, subject: key.did, claims }, key.privateKey, { created: null });
  const proof = await attachSignatureProfileA({
    type: HOLDER_PROOF_TYPE,
    audience: baseOf(audience),
    nonce: nonce(),
    created,
    manifest_digest: await manifestDigest(manifest),
  }, key.privateKey, { created: null });
  return { manifest, proof, pilot };
}

/**
 * Enter a world: read it, check it, disclose only what it asks for, and post the join.
 *   base      any URL of the world (its base URL is taken from it)
 *   wallet    { claims: { name: value }, credentials?: { name: issuer }, pilot: "human" | "agent" | "hybrid" }
 *             (what the visitor holds, and the visitor's pilot statement)
 *   withhold  names the visitor keeps back this time (never the pilot statement: every join carries it)
 * Returns { base, world, asked, plan, sent, pilot, pointer, status, answer, refused }.
 * `refused` is set, and nothing is sent, when the counterpart check fails or the visitor states no pilot.
 */
export async function enterWorld(base, { wallet, withhold = [], fetch: f = globalThis.fetch } = {}) {
  base = baseOf(base);
  const world = await readWorld(base, { fetch: f });
  const check = checkCounterpart(world, base);
  const asked = askedOf(world);
  if (!check.ok) return { base, world, asked, plan: null, sent: [], pointer: null, status: null, answer: null, refused: check.reason };
  const pilot = wallet && wallet.pilot;
  if (!PILOTS.includes(pilot)) return { base, world, asked, plan: null, sent: [], pilot: null, pointer: null, status: null, answer: null, refused: "the visitor states no pilot (human, agent or hybrid)" };
  const plan = planDisclosure(asked, wallet, { withhold });
  const values = {};
  for (const name of plan.send) values[name] = wallet.claims[name];
  const credentials = {};
  for (const name of plan.send) if (wallet.credentials && wallet.credentials[name]) credentials[name] = wallet.credentials[name];
  const key = await visitKey();
  const body = await presentation({ values, key, audience: base, credentials, pilot });
  const r = await f(new URL("wow/user", base).href, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/wow+json, application/json" },
    body: JSON.stringify(body),
    referrerPolicy: "no-referrer",
  });
  let answer = null;
  try { answer = await r.json(); } catch { answer = null; }
  return { base, world, asked, plan, sent: plan.send.slice(), pilot, pointer: key.did, status: r.status, answer, refused: null };
}

/**
 * The members a `preferences` claim may hold, each optional (provisional names; the lab world names the same
 * ones in runtime/world-server/src/runtime-handshake.js): preferred_height_m (a positive number of meters),
 * language (a BCP 47 tag) and the accessibility members captions, reduced_motion, seated, reduced_flashing
 * (booleans), text_scale (a positive number) and input (preferred input modalities, strings). At least one is
 * sent; the world reports each member it received as applied or not (`osl_preferences_applied` in its answer).
 * The agent sends whichever of them the visitor holds, unchanged.
 */
export const PREFERENCE_MEMBERS = Object.freeze(["preferred_height_m", "language", "captions", "reduced_motion", "seated", "text_scale", "input", "reduced_flashing"]);

/** The lab visitor of the after view: what they hold. Fixture values, provisional claim names. */
export const LAB_WALLET = Object.freeze({
  claims: Object.freeze({
    avatar: Object.freeze({ uri: "/assets/actionforge/characters/sophie/sophie.glb", label: "Sophie" }),
    display_name: "Ada",
    preferences: Object.freeze({ preferred_height_m: 1.85 }),
    age: 99,
  }),
});
