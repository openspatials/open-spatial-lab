#!/usr/bin/env node
// additive adversarial regression gate for the
// RP1 pointer/facet model. No enforcement or signing module is modified here.

import {
  buildRp1Section,
  RP1_POINTER_NAMES,
  SPATIAL_CONSENT_KEYS,
} from "./rp1-model.mjs";
import { UM_ENTITY_TYPE, UM_FACET_TYPE } from "./interfaces.mjs";

const ISSUED_AT = "2026-07-05T12:00:00.000Z";
let resistedCount = 0;
const findings = [];

function resisted(id, title, detail) {
  resistedCount += 1;
  console.log(`[${id}] ${title}`);
  console.log(`      RESISTED: ${detail}`);
}

function vulnerable(id, title, severity, repro) {
  findings.push({ id, title, severity, repro });
  console.log(`[${id}] ${title}`);
  console.log(`      ⚠️VULNERABLE (${severity}): ${repro}`);
}

function expect(id, title, safe, detail, severity, repro) {
  if (safe) resisted(id, title, detail);
  else vulnerable(id, title, severity, repro);
}

function nav(root = "world-a", child = "world-b") {
  return {
    context_id: `ctx-${root}`,
    single_context: true,
    root_fabric: { url: `https://${root}.demo.local/fabric.json`, container: root },
    child_fabric: { url: `https://${child}.demo.local/fabric.json`, container: child },
    portal_attachment: {
      node_id: `portal-${root}-${child}`,
      resolved_url: `https://${child}.demo.local/fabric.json`,
      transform_position: [1, 2, 3],
    },
  };
}

function build(source = nav(), opts = {}) {
  return buildRp1Section(source, { issuedAt: ISSUED_AT, ...opts });
}

function pointer(section, name) {
  return section.pointers.find((entry) => entry.name === name);
}

console.log("runtime RP1 pointer/facet model — ADVERSARIAL HARDENING HARNESS");
console.log("================================================================");
console.log("Attacking type confusion, default trust, dangling references, aliasing, and shape coercion.\n");

const baseline = build();
const exactPointerNames = Object.values(RP1_POINTER_NAMES);
const exactConsentNames = Object.values(SPATIAL_CONSENT_KEYS);
expect(
  "AV-0",
  "legitimate model control",
  baseline?.facets?.length === 4 && baseline.pointers.length === 6 && baseline.consents.length === 4,
  "the live crossing emits the expected 4 facets, 6 pointers, and 4 consents",
  "critical",
  `counts=${baseline?.facets?.length}/${baseline?.pointers?.length}/${baseline?.consents?.length}`
);

const rejectedShapes = [null, 7, "scope", {}, { root_fabric: {} }].every((value) => buildRp1Section(value, { issuedAt: ISSUED_AT }) === null);
expect("AV-1", "missing and primitive navigator shapes", rejectedShapes, "objects without a real scope emit no RP1 section", "high", "a missing/primitive/no-scope shape emitted portable state");

const injected = nav();
injected.pointers = [{ name: "rp1.admin", "@type": "rp1:trusted" }];
injected.facets = [{ name: "rootAuthority", "@type": "rp1:RootAdmin" }];
injected.consents = [{ name: SPATIAL_CONSENT_KEYS.crossWorldLinking, value: "allowed" }];
const injectionResult = build(injected);
expect(
  "AV-2",
  "source-object pointer/facet/consent injection",
  injectionResult.pointers.length === 6 && injectionResult.facets.length === 4 && injectionResult.consents.length === 4 && !injectionResult.pointers.some((p) => p.name === "rp1.admin"),
  "only builder-owned model entries are emitted",
  "critical",
  "unrecognized source arrays changed the emitted authority surface"
);

const unknownAttachment = build(nav(), { attachmentStatus: "fresh-enough" });
const wrappedAttachment = build(nav(), { attachmentStatus: new String("active") });
const attachmentStatuses = [pointer(unknownAttachment, RP1_POINTER_NAMES.attachmentIndex)?.status, pointer(wrappedAttachment, RP1_POINTER_NAMES.attachmentIndex)?.status];
expect(
  "AV-3",
  "unrecognized or boxed attachment status",
  attachmentStatuses.every((status) => status !== "active"),
  "explicit malformed status cannot be normalized upward to active",
  "high",
  `malformed attachment statuses normalized to ${attachmentStatuses.join("/")}`
);

const unknownSession = build(nav(), { sessionContextStatus: "verified" });
const wrappedSession = build(nav(), { sessionContextStatus: new String("active") });
const sessionStatuses = [pointer(unknownSession, RP1_POINTER_NAMES.sessionContext)?.status, pointer(wrappedSession, RP1_POINTER_NAMES.sessionContext)?.status];
expect(
  "AV-4",
  "unrecognized or boxed session status",
  sessionStatuses.every((status) => status !== "active"),
  "explicit malformed session state cannot be normalized upward to active",
  "high",
  `malformed session statuses normalized to ${sessionStatuses.join("/")}`
);

const unknownConsent = build(nav(), { crossWorldLinking: "allow" });
expect(
  "AV-5",
  "unrecognized cross-world consent token",
  unknownConsent.summary.cross_world_linking === "denied" && unknownConsent.consents.find((c) => c.name === SPATIAL_CONSENT_KEYS.crossWorldLinking)?.value === "denied",
  "unknown consent defaults to denied",
  "critical",
  `unknown consent became ${unknownConsent.summary.cross_world_linking}`
);

const facetIds = new Set(baseline.facets.map((facet) => facet["@id"]));
const facetRefsResolve = baseline.consents.every((consent) => typeof consent.facetRef === "string" && facetIds.has(consent.facetRef));
expect("AV-6", "dangling or forged consent facetRef", facetRefsResolve, "every consent binds to exactly one emitted attachment-policy facet", "critical", "one or more consent facetRef values were dangling");

const expectedEntityTypes = {
  spatialAnchors: "rp1:AnchorSet",
  placeMembership: "rp1:PlaceMembership",
  spatialFabricAttachmentPolicy: "rp1:AttachmentPolicy",
  spatialAssetProfile: "rp1:AssetProfile",
};
const facetTypesSafe = baseline.facets.every((facet) => {
  const facetTypes = Array.isArray(facet["@type"]) ? facet["@type"] : [facet["@type"]];
  const entityTypes = Array.isArray(facet.entity?.["@type"]) ? facet.entity["@type"] : [facet.entity?.["@type"]];
  return facetTypes.includes(UM_FACET_TYPE) && entityTypes.includes(UM_ENTITY_TYPE) && entityTypes.includes(expectedEntityTypes[facet.name]);
});
expect("AV-7", "facet/entity type confusion", facetTypesSafe, "all four facet types are builder-owned and exact", "high", "an emitted facet or entity lost its required RP1/UM type");

const pointerNames = baseline.pointers.map((entry) => entry.name);
const pointerShapeSafe = baseline.pointers.every((entry) => entry["@type"] === "rp1:pointer" && typeof entry.url === "string" && entry.target === entry.url) && new Set(pointerNames).size === exactPointerNames.length && exactPointerNames.every((name) => pointerNames.includes(name));
expect("AV-8", "pointer type/name confusion", pointerShapeSafe, "the exact six unique rp1.* pointer names keep the exact pointer type and target", "high", `emitted pointers=${pointerNames.join(",")}`);

const consentNames = baseline.consents.map((entry) => entry.name);
expect(
  "AV-9",
  "unrecognized consent entry default-trust",
  new Set(consentNames).size === exactConsentNames.length && exactConsentNames.every((name) => consentNames.includes(name)) && baseline.consents.every((entry) => entry["@type"] === "um:Consent"),
  "the exact four spatial.* consents are emitted with no catch-all trust entry",
  "high",
  `emitted consents=${consentNames.join(",")}`
);

const independentA = build();
const independentB = build();
pointer(independentA, RP1_POINTER_NAMES.attachmentIndex).status = "stale";
independentA.facets[0].entity.anchors.push({ id: "forged" });
expect(
  "AV-10",
  "cross-manifest object aliasing",
  pointer(independentB, RP1_POINTER_NAMES.attachmentIndex).status === "active" && !independentB.facets[0].entity.anchors.some((anchor) => anchor.id === "forged"),
  "each build owns fresh pointer/facet objects",
  "critical",
  "mutating one emitted model changed a separately built model"
);

const otherRoot = build(nav("world-c", "world-d"));
const scopedFacetNames = ["spatialAnchors", "placeMembership", "spatialFabricAttachmentPolicy"];
const scopedIdsDiffer = scopedFacetNames.every((name) => baseline.facets.find((facet) => facet.name === name)?.["@id"] !== otherRoot.facets.find((facet) => facet.name === name)?.["@id"]);
expect("AV-11", "scope-bearing facet identity aliasing across different roots", scopedIdsDiffer, "different root scopes receive disjoint IDs for every scope-bearing facet (the global asset-profile descriptor may stay stable)", "medium", "different roots shared a scope-bearing facet @id");

let nullOptsRejected = false;
try {
  nullOptsRejected = buildRp1Section(nav(), null) === null;
} catch {
  nullOptsRejected = true;
}
expect("AV-12", "null options shape", nullOptsRejected, "null options are rejected instead of elevating trust", "medium", "null options produced active portable state");

const sourceConsentInjection = nav();
sourceConsentInjection.crossWorldLinking = "allowed";
const sourceConsentResult = build(sourceConsentInjection);
expect(
  "AV-13",
  "navigator-field consent smuggling",
  sourceConsentResult.summary.cross_world_linking === "denied",
  "only the explicit options trust boundary can set the consent posture",
  "critical",
  `navigator.crossWorldLinking changed posture to ${sourceConsentResult.summary.cross_world_linking}`
);

const malformedUrls = {
  context_id: { forged: true },
  root_fabric: { url: { forged: "https://evil.example" }, container: 7 },
  child_fabric: { url: 9, container: { forged: true } },
  portal_attachment: { node_id: "portal-malformed", resolved_url: 9 },
};
const malformedUrlResult = build(malformedUrls);
const malformedAttachment = malformedUrlResult?.facets.find((facet) => facet.name === "spatialFabricAttachmentPolicy")?.entity?.attachments?.[0];
const noCoercedPointer = malformedUrlResult?.pointers.every((entry) => typeof entry.url === "string" && !entry.url.includes("[object Object]") && !/^\d/.test(entry.url));
expect(
  "AV-14",
  "non-string scope URL/container coercion",
  malformedUrlResult === null || (noCoercedPointer && typeof malformedAttachment?.childScopeRef === "string"),
  "malformed scope identifiers are omitted or replaced with explicit safe fallbacks",
  "high",
  `malformed identifiers survived as childScopeRef=${JSON.stringify(malformedAttachment?.childScopeRef)} pointers=${malformedUrlResult?.pointers.map((p) => p.url).join(",")}`
);

console.log("\n================================================================");
console.log(`VECTORS: ${resistedCount + findings.length}   RESISTED: ${resistedCount}   FINDINGS: ${findings.length}`);
if (findings.length === 0) console.log("VERDICT: SOUND — every hard model vector resisted.");
else {
  console.log("VERDICT: FINDINGS — model trust/shape defects remain:");
  for (const finding of findings) console.log(`  - [${finding.id}] (${finding.severity.toUpperCase()}) ${finding.title}`);
  process.exitCode = 1;
}
