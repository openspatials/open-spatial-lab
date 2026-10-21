// RP1 / Spatial-Fabric pointer + facet model (#1 PRIORITY).
//
// This module expresses the demo's LIVE World Navigator crossing (world A -> world B in
// ONE browsing context, via a child-fabric-attachment portal node that gets PROMOTED to
// root) in RP1's portable data model, so the emitted Universal Manifest carries the
// `rp1.*` pointers, `spatial.*` consent, and the RP1 facets that the RP1/MSF Spatial
// Fabric integration guidance calls for. It is the second Spatial-Fabric implementation
// standing up next to RP1 (Sean) — the "does the portable shape compose across a second
// ecosystem" evidence.
//
// ---------------------------------------------------------------------------
// WHAT THIS MAPS (the model, per the integration doc) — and WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// The authoritative model to map onto is
// and its acceptance fixtures (v0.1, NOT migrated to v0.4):
//   examples/v0.1/stubs/rp1-spatial-fabric-manifest.jsonld           (journey-07 happy path)
//   examples/v0.1/stubs/rp1-spatial-fabric-stale-attachment-manifest.jsonld  (J22 fail-closed)
//   examples/v0.1/stubs/rp1-spatial-fabric-revoked-session-manifest.jsonld   (J22 fail-closed)
//
// The integration doc's "useful portable distinction is PARENT scope vs CHILD scope"
// (§"What the primary sources now confirm" #3) is EXACTLY the demo's crossing: the boot
// (root) fabric is the parent scope; the portal-attachment node's referenced fabric is
// the child scope; crossing PROMOTES that child to root within the SAME context. So the
// crossing IS an RP1 parent-scope -> child-scope attachment, resolved in one context.
//
// This module MAPS onto RP1's portable state (integration doc §"What belongs in UM vs the
// runtime"):
//   - subject binding + consent controls        -> spatial.* consents (v0.4 consent shape)
//   - pointer routing to root/current fabric,    -> rp1.fabric / rp1.anchorSet / rp1.placeGraph
//     topology, anchor services, session context    / rp1.attachmentIndex / rp1.assetProfile
//                                                    / rp1.sessionContext (v0.4 pointer shape)
//   - compact attachment-policy summaries        -> spatialFabricAttachmentPolicy facet
//   - compact asset-profile declarations         -> spatialAssetProfile facet
//   - portable anchors / place membership        -> spatialAnchors / placeMembership facets
//
// It does NOT (deliberately — these are RUNTIME concerns per the integration doc):
//   - embed the live scope tree, node graph, or 3D payloads (asset profile is pointer-only)
//   - decide whether the child scope MAY open, whether the attachment is fresh, or whether
//     session context is reusable — those are the LIVE fabric's authorization decisions.
//   - flip any `um_conformance` flag. The RP1 FAIL-CLOSED conformance pass + journey-07/J22
//     acceptance is (this change builds the MODEL the 121 fail-closed edges sit on).
//
// ---------------------------------------------------------------------------
// v0.4 SHAPE vs v0.1 RP1 SEMANTICS (the reconciliation that keeps it ajv-valid)
// ---------------------------------------------------------------------------
// The demo's emitted manifest is v0.4-shaped (spec/v0.4/schema.json). The RP1 fixture
// SEMANTICS are v0.1 (unmigrated). v0.4 makes facets/pointers/consents STRICTER:
//   - a facet REQUIRES `@id` + `@type` (v0.1 required only `@type`);
//   - a pointer REQUIRES `@type` (v0.1 used bare {name,url});
//   - a consent REQUIRES `@id,@type,facetRef,scope,purpose,grantedAt,expiresAt`
//     (v0.1 used bare {name,value}).
// v0.4's `additionalProperties:true` on facet/pointer/consent lets us carry the RP1 v0.1
// semantic fields (the pointer's `name`/`url`/`observedAt`/`status`, the consent's
// `name`/`value`, the RP1 entity `@type` tokens `rp1:*`) ALONGSIDE the required v0.4 keys.
// So a v0.4 evaluator sees a structurally-valid v0.4 manifest; an RP1/MSF consumer reads
// the same `rp1.*` / `spatial.*` / `rp1:*` semantics the v0.1 stubs carry. This is the
// "consume the v0.1 RP1 shapes while emitting v0.4" composition the delta review called out.
//
// ZERO third-party deps; pure data over plain objects. Imports only the v0.4 facet/entity
// type constants from interfaces.mjs (single source of truth).

import { UM_FACET_TYPE, UM_ENTITY_TYPE } from "./interfaces.mjs";

// ===========================================================================
// RP1 vocabulary constants (the non-normative pointer/consent/facet names the
// integration doc suggests — integrations/rp1-spatial-fabric.md §"Suggested ...").
// ===========================================================================

/** The six suggested `rp1.*` pointer names (integration doc §"Suggested non-normative pointer names"). */
export const RP1_POINTER_NAMES = Object.freeze({
  fabric: "rp1.fabric", // root/current MSF entrypoint for the subject's active spatial context
  anchorSet: "rp1.anchorSet", // authorized anchor collection / anchor-service entrypoint
  placeGraph: "rp1.placeGraph", // place/topology resource for route or membership resolution
  attachmentIndex: "rp1.attachmentIndex", // index of attachment-capable child-scope links
  assetProfile: "rp1.assetProfile", // lightweight rendering/profile declaration
  sessionContext: "rp1.sessionContext", // optional, revocable runtime-session pointer
});

/** The four suggested `spatial.*` consent keys (integration doc §"Suggested non-normative consent keys"). */
export const SPATIAL_CONSENT_KEYS = Object.freeze({
  locationShare: "spatial.locationShare",
  anchorShare: "spatial.anchorShare",
  crossWorldLinking: "spatial.crossWorldLinking",
  sessionReplay: "spatial.sessionReplay",
});

/** The RP1 entity `@type` tokens the v0.1 stubs carry (kept verbatim so RP1 consumers recognize them). */
const RP1_ENTITY_TYPES = Object.freeze({
  anchorSet: "rp1:AnchorSet",
  placeMembership: "rp1:PlaceMembership",
  attachmentPolicy: "rp1:AttachmentPolicy",
  assetProfile: "rp1:AssetProfile",
});

// Machine-readable descriptor of what this RP1 model proves (scoped-descriptor pattern —
// mirrors UM_MANIFEST_EMISSION / IWPS_CONFORMANCE). NOT a conformance claim.
export const RP1_MODEL = Object.freeze({
  standard: "RP1 / MSF Spatial Fabric integration (non-normative)",
  integration_doc: "universalmanifest/integrations/rp1-spatial-fabric.md",
  maps: "World Navigator crossing -> RP1 parent-scope -> child-scope attachment, one context",
  emits: {
    pointers: Object.values(RP1_POINTER_NAMES),
    consents: Object.values(SPATIAL_CONSENT_KEYS),
    facets: ["spatialAnchors", "placeMembership", "spatialFabricAttachmentPolicy", "spatialAssetProfile"],
  },
  // v0.4-shaped (facets carry @id+@type; pointers carry @type; consents carry the v0.4
  // consent shape) while preserving the v0.1 RP1 semantics via additionalProperties.
  shape: "Universal Manifest v0.4 facets/pointers/consents; RP1 v0.1 semantics preserved",
  // This task does NOT flip a conformance flag: RP1 fail-closed conformance + journey-07/J22
  // acceptance is. The MODEL is here; the fail-closed edges + journeys sit on top.
  fail_closed_conformance: false,
  scope_boundary:
    "RP1 pointer/facet MODEL from live crossing state (parent/child scope + attachment). " +
    "Fail-closed traversal/session enforcement + journey-07/J22 acceptance = runtime. " +
    "um_conformance stays false.",
});

// ===========================================================================
// PUBLIC: derive the RP1 section from live crossing state.
// ===========================================================================

/**
 * Build the RP1 section (facets + pointers + consents) from the demo's live World Navigator
 * crossing state. Returns `null` when there is no navigator/crossing to describe (the emitter
 * then simply emits no RP1 section — the RP1 overlay is additive and optional).
 *
 * @param {object} nav  The live navigator debug object (adapter.debugState().navigator).
 *   Recognized fields (all optional; defensive — never throws on partial state):
 *     context_id        string  The single crossing context id (the "one context").
 *     single_context    bool    Whether world A + B live in ONE context (RP1 root scope).
 *     root_fabric       object  { url, container, node_count, ... } — the PARENT scope.
 *     child_fabric      object  { url, container, attached_at_portal_node, ... } — CHILD scope.
 *     portal_attachment object  { node_id, sReference, resolved_url, transform_position } —
 *                               the RP1 attachment point (parent -> child mount).
 *     promotion_count   number  How many child->root promotions have committed (crossings).
 *     last_promotion    object  The most recent promotion record (handoff_id, direction, ...).
 * @param {object} [opts]
 *     issuedAt          string  Manifest issuedAt (ISO). Anchors pointer freshness windows.
 *     ttlSeconds        number  Manifest lifetime (used to bound freshness expiries).
 *     crossWorldLinking "allowed"|"denied"  Consent for cross-world linkage. DEFAULT "denied"
 *                               (matches the RP1 stubs; the crossing is local, one-context).
 *     sessionContextStatus "active"|"stale"|"revoked"  Session-context status hint.
 *                               DEFAULT "active" — drives the "stale"/"revoked"
 *                               fail-closed edges; the happy path is "active".
 *     attachmentStatus  "active"|"stale"  Attachment-index freshness. DEFAULT "active".
 * @returns {null | { facets: object[], pointers: object[], consents: object[], summary: object }}
 */
export function buildRp1Section(nav, opts = {}) {
  if (!nav || typeof nav !== "object") return null;
  // Need at least a root fabric OR a portal attachment to describe an RP1 scope. If the
  // navigator never resolved a fabric, there is no portable RP1 state to emit.
  const hasScope =
    (nav.root_fabric && (isNonEmptyString(nav.root_fabric.url) || isNonEmptyString(nav.root_fabric.container))) ||
    (nav.portal_attachment && typeof nav.portal_attachment === "object") ||
    (nav.child_fabric && (isNonEmptyString(nav.child_fabric.url) || isNonEmptyString(nav.child_fabric.container)));
  if (!hasScope) return null;

  const issuedAt = isoOrNow(opts.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  const ttlSeconds = Number.isFinite(Number(opts.ttlSeconds)) ? Number(opts.ttlSeconds) : 3600;

  // Consent posture. The crossing is one-context/local by default, so cross-world linking is
  // DENIED by default (exactly the RP1 stubs' posture) — will drive real consent.
  const crossWorldLinking = normAllowDeny(opts.crossWorldLinking, "denied");
  const sessionStatus = normSessionStatus(opts.sessionContextStatus, "active");
  const attachmentStatus = normAttachmentStatus(opts.attachmentStatus, "active");

  // --- Portable scope ids -------------------------------------------------------------
  const rootScopeId = scopeIdFor(nav.root_fabric, "root");
  const childScopeRef = childScopeRefFor(nav);
  const attachment = attachmentSummaryFor(nav);

  // === Facets (each REQUIRES @id + @type in v0.4; entity keeps the rp1:* @type tokens) ===
  const facets = [];

  // 1) spatialAnchors — only the small portable anchor set the subject reuses. The demo's
  //    portable anchor is the PORTAL attachment (the reusable cross-scope entry), mirroring
  //    the stub's single portal anchor. Coordinates come from the live portal transform.
  const anchorsFacet = spatialAnchorsFacet(rootScopeId, attachment, nav);
  if (anchorsFacet) facets.push(anchorsFacet);

  // 2) placeMembership — the portable place/topology membership for the active scope.
  facets.push(placeMembershipFacet(rootScopeId, nav));

  // 3) spatialFabricAttachmentPolicy — THE core mapping: parent-scope -> child-scope mount,
  //    with the freshness source + fail-closed policy the integration doc requires.
  facets.push(
    spatialFabricAttachmentPolicyFacet(rootScopeId, childScopeRef, attachment, crossWorldLinking)
  );

  // 4) spatialAssetProfile — pointer-only external gltf/glb delivery (no embedded payloads).
  facets.push(spatialAssetProfileFacet());

  // === Consents (v0.4 consent shape; RP1 semantics preserved via name/value) ============
  // facetRef binds each consent to the attachment-policy facet it gates (v0.4 requires it).
  const attachmentPolicyFacetId = urnFacetId("spatialFabricAttachmentPolicy", rootScopeId);
  const consents = spatialConsents({
    facetRef: attachmentPolicyFacetId,
    issuedAt,
    ttlSeconds,
    crossWorldLinking,
    sessionReplay: "denied", // one-context crossing: no session replay (matches the stubs)
  });

  // === Pointers (v0.4 pointer shape; RP1 name/url/freshness preserved via extra members) ==
  const pointers = rp1Pointers({
    nav,
    rootFabricUrl: nav.root_fabric && isNonEmptyString(nav.root_fabric.url) ? nav.root_fabric.url : null,
    childScopeRef,
    issuedMs,
    attachmentStatus,
    sessionStatus,
  });

  const summary = {
    context_id: isNonEmptyString(nav.context_id) ? nav.context_id : null,
    single_context: nav.single_context === true,
    root_scope_id: rootScopeId,
    child_scope_ref: childScopeRef,
    attachment_point_id: attachment ? attachment.attachmentPointId : null,
    promotion_count: Number(nav.promotion_count) || 0,
    cross_world_linking: crossWorldLinking,
    attachment_status: attachmentStatus,
    session_context_status: sessionStatus,
    facet_count: facets.length,
    pointer_count: pointers.length,
    consent_count: consents.length,
  };

  return { facets, pointers, consents, summary };
}

// ===========================================================================
// Facet builders.
// ===========================================================================

/** spatialAnchors facet — the portable portal anchor (reusable cross-scope entry). */
function spatialAnchorsFacet(rootScopeId, attachment, nav) {
  // Only emit an anchor when we actually have an attachment point to anchor to.
  if (!attachment || !attachment.attachmentPointId) {
    // Still emit an (empty) anchor set so the facet vocabulary is present, per journey-07 step 5.
    return {
      "@id": urnFacetId("spatialAnchors", rootScopeId),
      "@type": UM_FACET_TYPE,
      name: "spatialAnchors",
      entity: {
        "@id": urnEntityId("spatialAnchors", rootScopeId),
        "@type": [UM_ENTITY_TYPE, RP1_ENTITY_TYPES.anchorSet],
        scopeId: rootScopeId,
        world: worldTokenFor(nav),
        anchors: [],
      },
    };
  }
  const coords = coordinatesFrom(attachment.transformPosition);
  const anchor = {
    id: `anchor-${attachment.attachmentPointId}`,
    kind: "portal",
    attachmentPointId: attachment.attachmentPointId,
    freshnessTtlSeconds: 900,
  };
  if (coords) anchor.coordinates = coords;
  return {
    "@id": urnFacetId("spatialAnchors", rootScopeId),
    "@type": UM_FACET_TYPE,
    name: "spatialAnchors",
    entity: {
      "@id": urnEntityId("spatialAnchors", rootScopeId),
      "@type": [UM_ENTITY_TYPE, RP1_ENTITY_TYPES.anchorSet],
      scopeId: rootScopeId,
      world: worldTokenFor(nav),
      anchors: [anchor],
    },
  };
}

/** placeMembership facet — portable place/topology membership for the active scope. */
function placeMembershipFacet(rootScopeId, nav) {
  const places = placesFor(nav);
  return {
    "@id": urnFacetId("placeMembership", rootScopeId),
    "@type": UM_FACET_TYPE,
    name: "placeMembership",
    entity: {
      "@id": urnEntityId("placeMembership", rootScopeId),
      "@type": [UM_ENTITY_TYPE, RP1_ENTITY_TYPES.placeMembership],
      scopeId: rootScopeId,
      places,
    },
  };
}

/**
 * spatialFabricAttachmentPolicy facet — the parent-scope -> child-scope mount. THE core
 * mapping. Declares the freshness source (rp1.attachmentIndex) + the fail-closed policy
 * (onFreshnessFailure = deny-child-scope-traversal) + the consent that gates the mount
 * (spatial.crossWorldLinking). Exactly the shape journey-07 step 6 + J22 assert.
 */
function spatialFabricAttachmentPolicyFacet(rootScopeId, childScopeRef, attachment, crossWorldLinking) {
  const att = {
    attachmentPointId: attachment ? attachment.attachmentPointId : "portal-attachment",
    parentPlace: `rp1:place:${rootScopeId}`,
    childScopeRef: childScopeRef || "urn:rp1:child-scope:unresolved",
    // The crossing is local/one-context by default; visibility follows the consent posture.
    linkVisibility: crossWorldLinking === "allowed" ? "cross-world" : "local-only",
    freshnessSource: RP1_POINTER_NAMES.attachmentIndex,
    onFreshnessFailure: "deny-child-scope-traversal", // FAIL-CLOSED
    consentRequired: [SPATIAL_CONSENT_KEYS.crossWorldLinking],
  };
  if (attachment && attachment.orientation) att.orientation = attachment.orientation;
  return {
    "@id": urnFacetId("spatialFabricAttachmentPolicy", rootScopeId),
    "@type": UM_FACET_TYPE,
    name: "spatialFabricAttachmentPolicy",
    entity: {
      "@id": urnEntityId("spatialFabricAttachmentPolicy", rootScopeId),
      "@type": [UM_ENTITY_TYPE, RP1_ENTITY_TYPES.attachmentPolicy],
      rootScopeId,
      compositionModel: "parent-scope-to-child-scope",
      attachments: [att],
    },
  };
}

/** spatialAssetProfile facet — pointer-only external gltf/glb delivery (no embedded 3D). */
function spatialAssetProfileFacet() {
  return {
    "@id": urnFacetId("spatialAssetProfile", "active"),
    "@type": UM_FACET_TYPE,
    name: "spatialAssetProfile",
    entity: {
      "@id": urnEntityId("spatialAssetProfile", "active"),
      "@type": [UM_ENTITY_TYPE, RP1_ENTITY_TYPES.assetProfile],
      deliveryFormats: ["gltf", "glb"],
      lodPolicy: "consumer-selects-supported-lod",
      transportBoundary: "external-pointer-only",
      toolingHints: ["manifolder-resource-view"],
      maxEmbeddedBytes: 0,
    },
  };
}

// ===========================================================================
// Consent builder (v0.4 consent shape; RP1 name/value preserved).
// ===========================================================================

/**
 * The four spatial.* consents in the v0.4 consent shape. v0.4 REQUIRES
 * @id,@type,facetRef,scope,purpose,grantedAt,expiresAt on each consent. We ADD `name`
 * (the rp1 consent key) + `value` (allowed/denied) so RP1/MSF consumers read the same
 * posture the v0.1 stubs' {name,value} consents carry.
 */
function spatialConsents({ facetRef, issuedAt, ttlSeconds, crossWorldLinking, sessionReplay }) {
  const grantedAt = issuedAt;
  const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
  const mk = (key, value, scope, purpose) => ({
    "@id": urnConsentId(key),
    "@type": "um:Consent",
    facetRef,
    scope,
    purpose,
    grantedAt,
    expiresAt,
    // RP1 v0.1 semantics preserved (additionalProperties:true):
    name: key,
    value,
  });
  return [
    mk(
      SPATIAL_CONSENT_KEYS.locationShare,
      "allowed",
      ["place-membership"],
      "share place membership (not precise coordinates) for wayfinding"
    ),
    mk(
      SPATIAL_CONSENT_KEYS.anchorShare,
      "allowed",
      ["saved-anchors"],
      "reuse intentionally-portable saved anchors across sessions"
    ),
    mk(
      SPATIAL_CONSENT_KEYS.crossWorldLinking,
      crossWorldLinking,
      ["child-scope-attachment"],
      "traverse a parent-scope -> child-scope attachment across worlds"
    ),
    mk(
      SPATIAL_CONSENT_KEYS.sessionReplay,
      sessionReplay,
      ["session-context"],
      "replay or reuse an active runtime session context"
    ),
  ];
}

// ===========================================================================
// Pointer builder (v0.4 pointer shape; RP1 name/url/freshness preserved).
// ===========================================================================

/**
 * The six rp1.* pointers in the v0.4 pointer shape. v0.4 REQUIRES `@type` on each pointer.
 * We use a stable RP1 pointer @type token and ADD the RP1 v0.1 semantic members
 * `name`/`url`/`observedAt`/`status` (additionalProperties:true) so RP1/MSF consumers read
 * the same routing + freshness the v0.1 stubs' {name,url,observedAt,expiresAt,status} carry.
 *
 * rp1.attachmentIndex + rp1.sessionContext carry explicit freshness (observedAt/expiresAt/
 * status) — the source J22 fail-closes on. On the happy path both are `active` and fresh
 * relative to issuance; drives the `stale`/`revoked` fail-closed edges.
 */
function rp1Pointers({ nav, rootFabricUrl, childScopeRef, issuedMs, attachmentStatus, sessionStatus }) {
  const base = rootFabricUrl ? deriveFabricBase(rootFabricUrl) : "urn:rp1:fabric";
  const ptr = (name, url, extra = {}) => ({
    "@type": "rp1:pointer",
    target: url,
    // RP1 v0.1 semantics preserved:
    name,
    url,
    ...extra,
  });

  // Freshness windows (ISO), anchored to manifest issuance. attachmentIndex: 15 min TTL;
  // sessionContext: 6 min TTL (the tight windows the near-real fixture + stubs use).
  const observedAt = isoAt(issuedMs + 2 * 60 * 1000); // observed 2 min into issuance window
  const attachmentExpiresAt =
    attachmentStatus === "stale"
      ? isoAt(issuedMs - 5 * 60 * 1000) // already expired at issuance (fail-closed input)
      : isoAt(issuedMs + 15 * 60 * 1000);
  const sessionObservedAt = isoAt(issuedMs + 3 * 60 * 1000);
  const sessionExpiresAt =
    sessionStatus === "revoked" || sessionStatus === "stale"
      ? isoAt(issuedMs - 1 * 60 * 1000) // already expired at issuance (fail-closed input)
      : isoAt(issuedMs + 6 * 60 * 1000);

  const pointers = [
    ptr(RP1_POINTER_NAMES.fabric, `${base}/index.msf`),
    ptr(RP1_POINTER_NAMES.anchorSet, `${base}/anchors`),
    ptr(RP1_POINTER_NAMES.placeGraph, `${base}/places`),
    ptr(RP1_POINTER_NAMES.attachmentIndex, `${base}/attachments`, {
      observedAt,
      expiresAt: attachmentExpiresAt,
      status: attachmentStatus,
    }),
    ptr(RP1_POINTER_NAMES.assetProfile, `${base}/asset-profile.json`),
    ptr(RP1_POINTER_NAMES.sessionContext, sessionContextUrl(nav, base), {
      observedAt: sessionObservedAt,
      expiresAt: sessionExpiresAt,
      status: sessionStatus,
    }),
  ];
  // Carry the resolved child-scope URL on the attachmentIndex pointer as advisory context
  // (the child scope this attachment index routes to) — additive, does not break the shape.
  if (childScopeRef) {
    const ai = pointers.find((p) => p.name === RP1_POINTER_NAMES.attachmentIndex);
    if (ai) ai.childScopeRef = childScopeRef;
  }
  return pointers;
}

// ===========================================================================
// Live-state -> portable-RP1 derivations.
// ===========================================================================

/** A stable, non-PII scope id derived from a fabric's container/url (e.g. "fs_world-a-boot"). */
function scopeIdFor(fabric, fallbackKind) {
  if (fabric) {
    const key = isNonEmptyString(fabric.container) ? fabric.container : isNonEmptyString(fabric.url) ? fabric.url : null;
    if (key) return `fs_${slugify(key)}`;
  }
  return `fs_${fallbackKind}`;
}

/** The child scope reference (the fabric the portal attachment mounts). Prefer the resolved URL. */
function childScopeRefFor(nav) {
  if (nav.child_fabric && isNonEmptyString(nav.child_fabric.url)) return nav.child_fabric.url;
  if (nav.portal_attachment && isNonEmptyString(nav.portal_attachment.resolved_url)) return nav.portal_attachment.resolved_url;
  if (nav.portal_attachment && isNonEmptyString(nav.portal_attachment.sReference)) return nav.portal_attachment.sReference;
  return null;
}

/** Compact attachment summary from the live portal_attachment node. */
function attachmentSummaryFor(nav) {
  const pa = nav.portal_attachment;
  if (!pa || typeof pa !== "object") return null;
  const summary = {
    attachmentPointId: pa.node_id != null ? String(pa.node_id) : "portal-attachment",
    transformPosition: Array.isArray(pa.transform_position) ? pa.transform_position : null,
  };
  return summary;
}

/** Places for the active scope. The demo has no rich place graph, so derive one stable place. */
function placesFor(nav) {
  const places = [];
  const rootPlace = nav.root_fabric && (isNonEmptyString(nav.root_fabric.container) ? nav.root_fabric.container : isNonEmptyString(nav.root_fabric.url) ? nav.root_fabric.url : null);
  const childPlace = nav.child_fabric && (isNonEmptyString(nav.child_fabric.container) ? nav.child_fabric.container : isNonEmptyString(nav.child_fabric.url) ? nav.child_fabric.url : null);
  if (rootPlace) {
    places.push(`rp1:place:${slugify(rootPlace)}`);
  }
  if (childPlace) {
    places.push(`rp1:place:${slugify(childPlace)}`);
  }
  if (places.length === 0) places.push("rp1:place:active-scope");
  return places;
}

/** A world token for the anchor set (rp1:<root-container>). */
function worldTokenFor(nav) {
  const root = nav.root_fabric && (isNonEmptyString(nav.root_fabric.container) ? nav.root_fabric.container : isNonEmptyString(nav.root_fabric.url) ? nav.root_fabric.url : null);
  if (root) {
    return `rp1:${slugify(root)}`;
  }
  return "rp1:active";
}

/** {x,y,z} from a live transform position [x,y,z] (rounded). null when absent. */
function coordinatesFrom(pos) {
  if (!Array.isArray(pos) || pos.length < 3) return null;
  const x = Number(pos[0]);
  const y = Number(pos[1]);
  const z = Number(pos[2]);
  if (![x, y, z].every((n) => Number.isFinite(n))) return null;
  return { x: round4(x), y: round4(y), z: round4(z) };
}

/** Derive an https fabric base from a fabric url (strips a trailing /fabric.json etc.). */
function deriveFabricBase(url) {
  const u = isNonEmptyString(url) ? url : "urn:rp1:fabric";
  // Strip a trailing file (/fabric.json, /index.msf) to a directory-ish base.
  const m = u.match(/^(https?:\/\/[^?#]*?)\/[^/?#]*\.[A-Za-z0-9]+([?#].*)?$/);
  if (m) return m[1];
  return u.replace(/\/+$/, "");
}

/** Session-context url from the live context id (revocable, ephemeral — integration doc). */
function sessionContextUrl(nav, base) {
  const ctx = isNonEmptyString(nav.context_id) ? slugify(nav.context_id) : "active";
  return `${base}/sessions/${ctx}/context`;
}

// ===========================================================================
// URN / identity helpers (namespaced so RP1 facet/pointer/consent @ids are stable + opaque).
// ===========================================================================
function urnFacetId(kind, id) {
  return `urn:um:facet:rp1:${kind}:${slugify(id)}`;
}
function urnEntityId(kind, id) {
  return `urn:um:entity:rp1:${kind}:${slugify(id)}`;
}
function urnConsentId(key) {
  return `urn:um:consent:${slugify(key)}`;
}

function slugify(v) {
  return (
    String(v == null ? "x" : v)
      .replace(/^https?:\/\//, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "x"
  );
}

// ===========================================================================
// Small value helpers.
// ===========================================================================
function isoOrNow(v) {
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return new Date().toISOString();
}
function isoAt(ms) {
  const t = Number.isFinite(ms) ? ms : Date.now();
  return new Date(t).toISOString();
}
function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function normAllowDeny(v, dflt) {
  return v === "allowed" || v === "denied" ? v : dflt;
}
function normSessionStatus(v, dflt) {
  if (v === undefined || v === null) return dflt;
  return v === "active" || v === "stale" || v === "revoked" ? v : "stale";
}
function normAttachmentStatus(v, dflt) {
  if (v === undefined || v === null) return dflt;
  return v === "active" || v === "stale" ? v : "stale";
}
