// OMA3 IWPS v0.3 Query+Teleport re-shape (SHARED, single source of truth).
//
// This leaf module is the ONE place the demo maps its crossing handshake onto the
// REAL OMA3 IWPS Base Specification v0.3 Query -> Teleport two-call protocol. It is
// imported by BOTH:
//   - the browser runtime (web/live-adapter.js), which SURFACES these IWPS-vocabulary
//     objects (the Query request/response + the Teleport request/response) built from
//     the exact packet it exchanges on the wire, AND
//   - anything that needs the scoped conformance descriptor (the UI panel + the e2e),
//     so the label the demo shows is the same scoped truth the driver asserts.
//
// It has ZERO browser dependencies (pure functions over plain objects), so it imports
// cleanly into Node from a `.mjs` file regardless of the prototype's package.json
// `type:commonjs` (which only governs `.js` resolution) — the same portability trick
// web/geopose-basic-sdu.mjs uses.
//
// Authoritative source, localized:
//   research/iwps-base-specification-v0.3.md (OMA3 IWPS Base Specification v0.3).
// Section references below (§5.3.2 Query API, §5.3.3 Teleport API, §3.5 Naming
// Conventions, §5.2 URIs, §5.4.1 No Security, §5.6 Asset Transfer TBD) cite it.
//
// ---------------------------------------------------------------------------
// THIS MODULE IS A READING, NOT A PROTOCOL. READ THIS FIRST.
// ---------------------------------------------------------------------------
// claimed `base_query_teleport: true`. THAT CLAIM WAS FALSE and it has
// been REMOVED. The honest claim it replaced — "IWPS-shaped portal handshake vocabulary
// for local proof only; no IWPS conformance claim" — was accurate, and this change restores
// that honesty with the exact gap stated.
//
// WHAT THIS MODULE ACTUALLY IS: a POST-HOC RENDERING, in IWPS v0.3 vocabulary, of a
// crossing THAT HAS ALREADY HAPPENED over our own demo-native protocol. It has ZERO
// network calls (no fetch, no import of anything network-capable). It is invoked from
// web/live-adapter.js AFTER both real POSTs have completed, and its output is written
// into a local debug object. It is a DESIGN STUDY — a complete, spec-cited mapping of our
// crossing onto IWPS — and that is a genuinely useful artifact. It is NOT an
// implementation of the IWPS protocol, and nothing here may be labelled as one.
//
// WHAT IS TRUE (and it is not nothing):
//   - The crossing really does make TWO POSTs, in IWPS's Query -> Teleport ORDER (§5.1.1),
//     to TWO GENUINELY SEPARATE world servers. The two-service topology IWPS assumes is
//     real here, not simulated.
//   - The URL paths are kebab-case and POST-only, matching §5.2.1 and §3.5.3.
//   - The mapping below is complete and spec-cited. It is exactly the artifact you would
//     need in order to BECOME conformant.
//
// WHAT IS NOT TRUE — the gap, stated exactly:
//   - NO IWPS PARAMETER IS ON THE WIRE. The real request body is one snake_case demo
//     field, `{portal_id}`; the response packet is entirely snake_case (`handoff_id`,
//     `arrival_position`, ...). Not one Table 1 / Table 3 parameter is transmitted.
//   - THE DESTINATION IMPLEMENTS NEITHER API. It serves our own demo routes. A Destination
//     Cloud SHALL support the Query API (§5.3.2) and a Destination Service SHALL support
//     the Teleport API (§5.3.3). Ours supports neither.
//   - `approval` AND `destinationUrl` — BOTH MANDATORY (§5.3.2 Table 2) — ARE SYNTHESIZED
//     IN THE BROWSER, not returned by a server. See the `_synthesized` markers below.
//   - `sourceAckUrl` / `sourceNackUrl` (§5.3.3 step 9 — a SHALL) ARE NEVER CALLED. No route
//     serves them anywhere in this repo. They are constructed strings and nothing more.
//   - `teleportId` is our `handoff_id`, NOT a UUID v4 (§5.3.2 Table 1).
//   - `teleportPin` is a DETERMINISTIC HASH of the handoff id, not "randomly generated"
//     (§5.3.2 Table 1). A PIN derived from the transaction it is meant to authenticate
//     defeats its own purpose (§5.3.3 step 6). There is no PIN UX.
//   - `expiration` is hardcoded 0 and is enforced nowhere.
//
// BLOCKED UPSTREAM, NOT BY US: Asset Transfer (§5.6), Look-and-Feel (§5.7) and Payments
// (§5.8) are the literal word "TBD" in the shipped v0.3 specification. THERE IS NOTHING TO
// CONFORM TO. `assets: null` is the CORRECT behaviour ("Reserved for Future Use") — do not
// size it, do not promise it.
//
// SECURITY PROFILE: No Security (§5.4.1) — and §5.4 line 491 is the consequence: such
// Worlds "SHALL NOT be able to connect to Worlds that require internet or OMA3 security."
// This build is SPEC-PROHIBITED from ever interoperating with a real secured IWPS world.
//
// `iwps_conformance` IS AND STAYS `false`. Every other conformance flag in the demo is
// UNAFFECTED by this module.
//
// THE VERIFIER RULE: no IWPS property may be labelled `true` until a harness inspects the
// WIRE. tools/wow-conformance/crossing-proof.js used to "verify" this claim by
// GREPPING THIS FILE FOR THE STRING `base_query_teleport: true`. It would have passed
// identically if the protocol did not exist. It now asserts what is actually on the wire —
// including asserting that the IWPS fields are ABSENT from it, which is the truth.

// Machine-readable descriptor of the conformance status. This is the object the demo
// surfaces as `iwps_conformance` (proof_boundary + player handoff profile) and the exact
// shape the UI panel and the e2e driver read.
export const IWPS_CONFORMANCE = Object.freeze({
  standard: "OMA3 IWPS Base Specification v0.3",
  // The headline. STAYS FALSE. This module earns nothing.
  iwps_conformance: false,
  // What we DO have: two POSTs, Query->Teleport order, kebab-case, POST-only. §5.1.1/§5.2.1/§3.5.3.
  shaped: true,
  // set this `true`. IT WAS NOT EARNED — the destination implements
  // neither the Query nor the Teleport API. REMOVED BY.
  base_query_teleport: false,
  wire_vocabulary:
    "demo-native snake_case ({portal_id}, handoff_id). IWPS camelCase is a POST-HOC READING, never transmitted.",
  mandatory_response_fields:
    "approval + destinationUrl (§5.3.2 Table 2, both M) are SYNTHESIZED IN THE BROWSER, not returned by a server",
  ack_nack: "NOT IMPLEMENTED — sourceAckUrl/sourceNackUrl (§5.3.3 step 9, a SHALL) are served by no route and never called",
  teleport_id: "handoff_id alias; NOT a UUID v4 (§5.3.2 Table 1)",
  teleport_pin: "deterministic hash of handoff_id; NOT randomly generated (§5.3.2 Table 1); no PIN UX",
  expiration: "hardcoded 0; enforced nowhere (§5.3.3 step 4)",
  // Runs over plain same-origin transport, no TLS/OMA3 cert program (§5.4.1). NAMED.
  profile: "No-Security (§5.4.1) — per §5.4 this build SHALL NOT interoperate with Internet- or OMA3-security IWPS worlds",
  // NOT our gap: the spec itself says "TBD".
  assets: "blocked upstream — §5.6 Asset Transfer Framework is the literal word 'TBD' in the shipped v0.3 spec",
  full_conformance: false,
  spec_sections: {
    query_api: "§5.3.2 Query API (Table 1/2) — NOT IMPLEMENTED by our destination",
    teleport_api: "§5.3.3 Teleport API (Table 3/4) — NOT IMPLEMENTED by our destination",
    naming: "§3.5 Naming Conventions (camelCase keys, kebab-case URL paths)",
    uris: "§5.2 Uniform Resource Identifiers and Locators",
    call_order: "§5.1.1 API Flow Overview (Query then Teleport) — the one property we genuinely hold",
    security: "§5.4.1 No Security profile",
    assets: "§5.6 Asset Transfer Framework (TBD in the spec — nothing to conform to)",
  },
  // The one-line claim. Worded so it CANNOT be read as a conformance claim.
  claim:
    "IWPS-SHAPED, NOT IWPS-CONFORMANT: Query->Teleport call order and vocabulary, rendered " +
    "post-hoc from our own crossing. No IWPS parameter is on the wire; the destination " +
    "implements neither API.",
});

// One-line human label the UI std-iwps panel prints. Kept beside the descriptor so the
// panel and the wire never drift.
export const IWPS_CONFORMANCE_LABEL =
  "iwps_conformance: false · IWPS-SHAPED (2 POSTs, Query→Teleport order, kebab-case) · NOT IWPS-CONFORMANT: no IWPS parameter on the wire, destination implements neither API, ack/nack never called";

// The kebab-case IWPS URL PATHS the crossing exercises (§3.5.3 URL paths, §5.2). The
// homegrown same-origin routes (/portal/exit-intent, /portal/arrival) are ALREADY
// kebab-case and remain the transport the demo POSTs to (the local 041 backend is left
// unmodified by design); these are the IWPS role names for the exact same two POSTs so
// the panel/evidence can show the protocol reading. `queryPath` == the Query API on the
// Portal URI; `teleportPath` == the Teleport API on the Destination URI.
export const IWPS_URLS = Object.freeze({
  // Query API terminates at the Destination Cloud (Portal URI). §5.3.2.
  queryPath: "/portal/exit-intent",
  // Teleport API terminates at the Destination Service (Destination URI). §5.3.3.
  teleportPath: "/portal/arrival",
  naming_rule: "kebab-case URL paths per IWPS §3.5.3",
});

/**
 * Build the IWPS v0.3 URIs (§5.2) from the demo's source/target endpoints.
 * [protocol]://[domain]/[location]?<parameters>; all URLs POST-only (§5.2.1).
 * The `location` segment is the opaque landing-location string (§5.3.2 Table 2).
 */
export function iwpsUris({ sourceBaseUrl, targetBaseUrl, location }) {
  const loc = opaqueLocation(location);
  const portalUri =
    (targetBaseUrl || "") + IWPS_URLS.queryPath + (loc ? `?location=${encodeURIComponent(loc)}` : "");
  const destinationUri = (targetBaseUrl || "") + IWPS_URLS.teleportPath;
  return {
    // Portal URI: the marketing IWPS link the Query API is called on (§5.2.2).
    portalUrl: portalUri,
    // Destination URI: returned by Query, the Teleport API is called on it (§5.2.3).
    destinationUrl: destinationUri,
    sourceBaseUrl: sourceBaseUrl || null,
    method: "POST",
  };
}

/**
 * The opaque landing `location` string (§5.3.2 Table 2). IWPS treats `location` as a
 * single text token "in a form determined by the Destination World" — NOT a rich pose.
 * The demo's rich pose stays in its own labeled payload; here we serialize just the
 * landing spot the destination chose into one opaque token.
 */
export function opaqueLocation(arrival) {
  if (typeof arrival === "string") return arrival;
  if (!arrival || typeof arrival !== "object") return null;
  const pos = Array.isArray(arrival.position) ? arrival.position : null;
  const rot =
    arrival.rotation_y != null ? Number(arrival.rotation_y) : null;
  if (!pos) return arrival.location || null;
  // A compact, destination-defined token. Opaque to IWPS; the demo can parse it back.
  const round = (n) => Number(Number(n || 0).toFixed(4));
  return `loc:${round(pos[0])},${round(pos[1])},${round(pos[2])}` + (rot != null ? `;yaw=${round(rot)}` : "");
}

/**
 * teleportId (§5.3.2/§5.3.3): "UUID v4 randomly generated by the Source Client when
 * Teleportation is initiated". The demo's internal correlation key is `handoff_id`
 * (kept STABLE so the e2e correlation and the 041 backend are untouched). This is the
 * ADAPTER seam: on the wire the id is surfaced under the IWPS name `teleportId`, while
 * the internal machinery keeps calling it `handoff_id`. They are the SAME value.
 */
export function teleportIdFromHandoff(handoffId) {
  return handoffId != null ? String(handoffId) : null;
}

/**
 * A 2-digit decimal teleportPin (§5.3.2 Table 1 / §5.3.3 Table 3), derived
 * deterministically from the handoff id so it is stable for a given crossing (the demo
 * does not surface a PIN UX; this is vocabulary completeness for the protocol reading).
 */
export function teleportPinFromHandoff(handoffId) {
  const s = String(handoffId || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100;
  return h; // 0..99, a 2-digit decimal number
}

/**
 * Map the demo's internal handoff packet onto the IWPS v0.3 **Query API** request +
 * response (§5.3.2, Table 1/2). camelCase keys (§3.5.1). This is the negotiation call:
 * the Source Service calls Query on the Portal URI; the Destination Cloud returns
 * approval + the Destination URI + the opaque landing `location`.
 *
 * `sourceClientType: "browser"` (§5.3.2 Table 1 A.1) because the demo Client is a
 * browser application (§4.2.2). Fields the demo does not support are OMITTED, per the
 * spec: "In case such a field is not supported, the field SHALL NOT be returned" (§5.3.1)
 * and the A.1/A.2 bundle rule "If any of these parameters are unknown they should not be
 * included."
 */
export function iwpsQueryFromHandoff(packet) {
  const p = packet && typeof packet === "object" ? packet : {};
  const source = p.source || {};
  const target = p.target || {};
  const teleportId = teleportIdFromHandoff(p.handoff_id);
  const uris = iwpsUris({
    sourceBaseUrl: source.base_url,
    targetBaseUrl: target.base_url,
    location: target.arrival_position != null
      ? { position: target.arrival_position, rotation_y: target.arrival_rotation_y }
      : null,
  });
  const location = opaqueLocation({
    position: target.arrival_position,
    rotation_y: target.arrival_rotation_y,
  });
  const avatarContext = p.avatar_context || {};
  const userId = avatarContext.continuity_id || avatarContext.avatar_id || null;
  // Query REQUEST (Source Service -> Destination Cloud on the Portal URI). Table 1.
  const request = {
    // A.1 bundle — client/device characteristics (browser application, §4.2.2).
    sourceClientType: "browser", // enum [browser, application]
    // A.2 bundle — teleport correlation + ack/nack callbacks.
    teleportId, // UUID v4 (the demo's handoff_id, surfaced under the IWPS name)
    userId,
    teleportPin: teleportPinFromHandoff(p.handoff_id),
    // sourceAckUrl / sourceNackUrl (§5.3.2 Table 1 A.2): URIs the Destination Service
    // calls on success / failure. Kebab-case paths (§3.5.3).
    sourceAckUrl: (source.base_url || "") + "/portal/source-ack",
    sourceNackUrl: (source.base_url || "") + "/portal/source-nack",
    // location is OPTIONAL (§5.3.2 Table 1) — the requested landing spot, opaque token.
    location,
    // assets: Reserved for Future Use (§5.3.2 Table 1 A.2 / §5.6). Deferred.
    assets: null,
  };
  // Query RESPONSE (Destination Cloud -> Source Service). Table 2.
  //
  // ⚠️ NOTHING IN THIS OBJECT WAS RECEIVED FROM A SERVER. Our destination implements no
  // IWPS Query API (§5.3.2 — a SHALL) and returns no Table 2 field. Every value below is
  // SYNTHESIZED IN THE BROWSER from data we already had. `approval` and `destinationUrl`
  // are the two MANDATORY (M) fields of the Query response, and both are fabricated here.
  // This is the single sharpest reason `iwps_conformance` is false. Do not remove these
  // markers; they are what stops this object being read as a protocol response.
  const response = {
    approval: true, // M (§5.3.2 Table 2) — HARDCODED LITERAL. Nothing approved anything.
    // location: approved landing location. NOT approved by a destination — computed locally.
    location,
    destinationUrl: uris.destinationUrl, // M — COMPUTED LOCALLY from target.base_url, not returned
    portalUrl: uris.portalUrl, // O — updated Portal URI, also computed locally
    expiration: 0, // A.2 — HARDCODED. No expiration is enforced anywhere (§5.3.3 step 4).
    _synthesized: true,
    _not_received:
      "SYNTHESIZED CLIENT-SIDE. The destination implements no IWPS Query API (§5.3.2) and " +
      "returned none of these fields. approval + destinationUrl are Mandatory (Table 2) and " +
      "are fabricated here. NOT a protocol response.",
  };
  return {
    api: "Query",
    spec: IWPS_CONFORMANCE.spec_sections.query_api,
    method: "POST",
    portalUrl: uris.portalUrl,
    request,
    response,
  };
}

/**
 * Map the demo's internal handoff packet onto the IWPS v0.3 **Teleport API** request +
 * response (§5.3.3, Table 3/4). camelCase keys (§3.5.1). This is the execute call: the
 * Source Service calls Teleport on the Destination URI; on completion the Destination
 * Service returns approval and SHALL call sourceAckUrl (success) or sourceNackUrl
 * (failure) — §5.3.3 step 9.
 */
export function iwpsTeleportFromHandoff(packet) {
  const p = packet && typeof packet === "object" ? packet : {};
  const source = p.source || {};
  const target = p.target || {};
  const teleportId = teleportIdFromHandoff(p.handoff_id);
  const uris = iwpsUris({
    sourceBaseUrl: source.base_url,
    targetBaseUrl: target.base_url,
    location: target.arrival_position != null
      ? { position: target.arrival_position, rotation_y: target.arrival_rotation_y }
      : null,
  });
  const avatarContext = p.avatar_context || {};
  const userId = avatarContext.continuity_id || avatarContext.avatar_id || null;
  // Teleport REQUEST (Source Service -> Destination Service on the Destination URI). Table 3.
  const request = {
    teleportId, // M (§5.3.3 Table 3)
    teleportPin: teleportPinFromHandoff(p.handoff_id), // O
    userId, // O
    // launchClient: false — the demo's Source Client performs the composition itself
    // (the child fabric is promoted in the SAME context); the Destination Service is
    // NOT asked to launch a separate Destination Client. §5.3.3 Table 3 (default false).
    launchClient: false,
    sourceAckUrl: (source.base_url || "") + "/portal/source-ack", // O
    sourceNackUrl: (source.base_url || "") + "/portal/source-nack", // O
    // assets: Reserved for Future Use (§5.3.3 Table 3 / §5.6). Deferred.
    assets: null,
  };
  // Teleport RESPONSE (Destination Service -> Source Service). Table 4.
  // ⚠️ Same as the Query response: NOT RECEIVED. Our destination implements no IWPS
  // Teleport API (§5.3.3 — a SHALL) and returns no `approval`.
  const response = {
    approval: true, // M (§5.3.3 Table 4) — HARDCODED LITERAL. Nothing approved anything.
    _synthesized: true,
    _not_received:
      "SYNTHESIZED CLIENT-SIDE. The destination implements no IWPS Teleport API (§5.3.3) " +
      "and returned no `approval` (Mandatory, Table 4). NOT a protocol response.",
  };
  return {
    api: "Teleport",
    spec: IWPS_CONFORMANCE.spec_sections.teleport_api,
    method: "POST",
    destinationUrl: uris.destinationUrl,
    request,
    response,
    // §5.3.3 step 9: the Destination Service SHALL call sourceAckUrl on success or
    // sourceNackUrl on failure.
    //
    // ⚠️ WE DO NOT DO THIS. These are DEAD STRINGS. No route in this repo serves
    // /portal/source-ack or /portal/source-nack (verified: the 041 backend serves only
    // /portal/exit-intent and /portal/arrival), and nothing ever calls them. They are
    // constructed here so the protocol READING is complete, and they are named as
    // NOT IMPLEMENTED so the reading cannot be mistaken for the protocol.
    ackCallback: request.sourceAckUrl,
    nackCallback: request.sourceNackUrl,
    ack_nack_implemented: false,
    ack_nack_note:
      "§5.3.3 step 9 is a SHALL and we DO NOT satisfy it: sourceAckUrl/sourceNackUrl are " +
      "served by no route and are never called. Dead strings, named honestly.",
  };
}

/**
 * Build the full IWPS v0.3 Query+Teleport reading of a crossing from the demo's internal
 * handoff packet: the two calls, their kebab-case URLs, the opaque `location`, the
 * teleportId (== handoff_id), and the scoped conformance descriptor. This is the object
 * the player handoff profile surfaces (replacing the old `iwps_shaped_handshake`) and
 * the panel reads. Pure — takes the packet, returns the vocabulary view. The internal
 * `handoff_id` correlation key is left untouched on the packet itself.
 */
export function iwpsQueryTeleportFromHandoff(packet, extra = {}) {
  const p = packet && typeof packet === "object" ? packet : {};
  const query = iwpsQueryFromHandoff(p);
  const teleport = iwpsTeleportFromHandoff(p);
  return {
    _claim: IWPS_CONFORMANCE.claim,
    standard: IWPS_CONFORMANCE.standard,
    // The two-call flow, in order (§5.1.1 API Flow Overview): Query then Teleport.
    flow: ["Query", "Teleport"],
    // teleportId is the IWPS name for the demo's internal handoff_id (adapter seam):
    // renamed ON THE WIRE, correlation-stable INTERNALLY.
    teleportId: query.request.teleportId,
    correlation_note:
      "IWPS teleportId is the demo's internal handoff_id (adapter alias): the on-the-wire " +
      "vocabulary is IWPS v0.3; the internal correlation key stays handoff_id so the e2e " +
      "correlation and the 041 backend are untouched.",
    location: query.response.location, // the single opaque landing token (§5.3.2 Table 2)
    query,
    teleport,
    // The actual same-origin transport the demo POSTs to (the 041 backend, unmodified).
    //
    // ⚠️ THESE POSTs CARRY NO IWPS VOCABULARY. That is the whole finding. The Query leg's
    // real body is `{portal_id: "<string>"}` — one snake_case demo field — and the response
    // is entirely snake_case (`handoff_id`, `arrival_position`, ...). The IWPS role name is
    // given because the CALL ORDER and the KEBAB-CASE POST-only paths genuinely do match
    // §5.1.1 / §5.2.1 / §3.5.3 — that, and only that, is what "IWPS-shaped" means here.
    transport: {
      iwps_parameters_on_the_wire: false,
      wire_format: "demo-native snake_case; request body is {portal_id}, response is handoff_id/arrival_position/...",
      query_call: {
        iwps_api: "Query",
        posted_to: extra.query_endpoint || null,
        role: "OUR OWN demo crossing POST. IWPS-shaped only in call order + kebab-case POST-only path. " +
              "Carries ZERO IWPS Table 1 parameters. The destination implements no IWPS Query API (§5.3.2).",
        iwps_api_implemented_by_destination: false,
      },
      teleport_call: {
        iwps_api: "Teleport",
        posted_to: extra.teleport_endpoint || null,
        role: "OUR OWN demo crossing POST. IWPS-shaped only in call order + kebab-case POST-only path. " +
              "Carries ZERO IWPS Table 3 parameters. The destination implements no IWPS Teleport API (§5.3.3).",
        iwps_api_implemented_by_destination: false,
      },
    },
    // The headline, repeated at the top level so no consumer can read this block without it.
    iwps_conformance: false,
    conformance: { ...IWPS_CONFORMANCE },
  };
}
