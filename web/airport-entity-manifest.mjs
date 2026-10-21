// canonical airport entity manifest/card projection.
// The fixture owns the data. This module only validates the one-to-one binding
// and derives the short public card; no parallel profile or card-data registry.

export const AIRPORT_ENTITY_ROLES = Object.freeze(["npc-traveler", "store-staff", "storefront"]);

function nodeList(graph) {
  const raw = graph && graph.nodes;
  return Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publicProfile(manifest) {
  const facets = Array.isArray(manifest?.facets) ? manifest.facets : [];
  const facet = facets.find((candidate) => candidate?.name === "publicProfile");
  return facet?.entity && typeof facet.entity === "object" ? facet.entity : null;
}

/** Derive the only strings the renderer is allowed to show from a bound UM. */
export function deriveAirportManifestCard(node) {
  const extension = node?.webofworlds_extension || {};
  const manifest = extension.universal_manifest;
  const anchor = extension.manifest_card_anchor;
  const entity = publicProfile(manifest);
  const errors = [];

  if (!manifest || typeof manifest !== "object") errors.push("missing Universal Manifest");
  if (manifest?.["@context"] !== "https://universalmanifest.net/ns/v0.4") errors.push("unsupported manifest context");
  if (manifest?.["@type"] !== "um:Manifest" || manifest?.manifestVersion !== "0.4") errors.push("invalid manifest version/type");
  if (!text(manifest?.["@id"]) || !text(manifest?.subject)) errors.push("missing manifest identity");
  if (!entity) errors.push("missing publicProfile entity");

  const subjectId = text(entity?.subjectId);
  const objectId = text(entity?.objectId);
  const anchorId = text(entity?.anchorId);
  const displayName = text(entity?.displayName);
  const entityType = text(entity?.entityType);
  const role = text(entity?.role);
  const summary = text(entity?.summary);
  if (!subjectId || !objectId || !anchorId || !displayName || !entityType || !role || !summary) {
    errors.push("publicProfile card fields are incomplete");
  }
  if (anchorId !== text(anchor?.anchor_id)) errors.push("manifest/card anchor mismatch");
  const position = Array.isArray(anchor?.position_m) ? anchor.position_m.map(Number) : [];
  if (position.length !== 3 || position.some((value) => !Number.isFinite(value))) errors.push("invalid authored card anchor");
  const actorSubject = text(extension.actor?.subject_id);
  if (actorSubject && actorSubject !== subjectId) errors.push("actor/manifest subject mismatch");
  const signature = manifest?.signature;
  if (
    signature?.algorithm !== "Ed25519" ||
    signature?.canonicalization !== "JCS-RFC8785" ||
    !text(signature?.keyRef) ||
    !text(signature?.publicKeySpkiB64) ||
    !text(signature?.value)
  ) errors.push("invalid signature envelope");

  const provenance = entity?.provenance || {};
  if (
    provenance.authorship !== "OSL-authored demo fixture" ||
    provenance.simulation !== true ||
    provenance.verification !== "unverified" ||
    provenance.umConformanceClaimed !== false
  ) errors.push("dishonest or incomplete demo provenance");

  const matrix = Array.isArray(node?.localTransform) && node.localTransform.length === 16 ? node.localTransform : null;
  const fallbackPosition = [Number(matrix?.[12]) || 0, (Number(matrix?.[13]) || 0) + 2.4, Number(matrix?.[14]) || 0];
  return {
    ok: errors.length === 0,
    errors,
    node_id: String(node?.id ?? ""),
    node_label: text(node?.label) || "Airport entity",
    semantic_role: text(extension.role),
    manifest,
    manifest_id: text(manifest?.["@id"]),
    manifest_version: text(manifest?.manifestVersion),
    subject_id: subjectId,
    object_id: objectId,
    anchor_id: anchorId,
    anchor_position_m: position.length === 3 && position.every(Number.isFinite) ? position : fallbackPosition,
    display_name: displayName,
    entity_type: entityType,
    role,
    summary,
    provenance: {
      authorship: text(provenance.authorship),
      simulation: provenance.simulation === true,
      verification: text(provenance.verification),
      um_conformance_claimed: provenance.umConformanceClaimed === true,
    },
  };
}

export function listAirportEntityRecords(graph) {
  return nodeList(graph)
    .filter((node) => AIRPORT_ENTITY_ROLES.includes(node?.webofworlds_extension?.role))
    .map((node) => ({ node, card: deriveAirportManifestCard(node) }));
}

export function validateAirportEntityInventory(graph) {
  const records = listAirportEntityRecords(graph);
  const errors = [];
  const unique = {
    manifest_id: new Map(),
    subject_id: new Map(),
    object_id: new Map(),
    anchor_id: new Map(),
  };
  for (const record of records) {
    if (!record.card.ok) errors.push(...record.card.errors.map((error) => `node ${record.card.node_id}: ${error}`));
    for (const [field, seen] of Object.entries(unique)) {
      const value = record.card[field];
      if (!value) continue;
      if (seen.has(value)) errors.push(`duplicate ${field} ${value} on nodes ${seen.get(value)} and ${record.card.node_id}`);
      else seen.set(value, record.card.node_id);
    }
  }
  const count = (role) => records.filter((record) => record.card.semantic_role === role).length;
  const counts = { travelers: count("npc-traveler"), staff: count("store-staff"), storefronts: count("storefront") };
  if (counts.travelers !== 5) errors.push(`expected 5 travelers, found ${counts.travelers}`);
  if (counts.staff !== 4) errors.push(`expected 4 store staff, found ${counts.staff}`);
  if (counts.storefronts !== 4) errors.push(`expected 4 storefronts, found ${counts.storefronts}`);
  return { ok: errors.length === 0, errors, counts, records };
}

export default { AIRPORT_ENTITY_ROLES, deriveAirportManifestCard, listAirportEntityRecords, validateAirportEntityInventory };
