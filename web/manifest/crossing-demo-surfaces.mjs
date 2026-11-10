import { attachTrustTier, attachHolderBinding, attachReceipt } from "./crossing-trust-surfaces.mjs";
import { attachAgentDelegation, attachEntityPersonhood, attachStatusref } from "./crossing-identity-surfaces.mjs";
import { attachSealedFacets, attachLivenessAssurance, attachPrivateData, attachFormatIndependence } from "./crossing-private-surfaces.mjs";
import { attachBilateralSession } from "./crossing-bilateral-surface.mjs";
import { attachHigherTierProofs, attachRp1SomGating } from "./crossing-som-surface.mjs";

const surfaces = [
  ["um_trust_tier_v04", attachTrustTier],
  ["um_holder_binding_v04", attachHolderBinding],
  ["um_sealed_facets_v04", attachSealedFacets],
  ["um_agent_delegation_v04", attachAgentDelegation],
  ["um_receipt_v04", attachReceipt],
  ["um_entity_personhood_v04", attachEntityPersonhood],
  ["um_statusref_v04", attachStatusref],
  ["um_liveness_assurance_v04", attachLivenessAssurance],
  ["um_higher_tier_proofs_v04", attachHigherTierProofs],
  ["um_bilateral_session_v04", attachBilateralSession],
  ["um_private_data_v04", attachPrivateData],
  ["um_format_independence_v04", attachFormatIndependence],
  ["um_rp1_som_gating_v04", attachRp1SomGating],
];

// Ordering is diagnostic only; the traversal owner decides whether results may publish.
export async function enrichCrossingDemoSurfaces(context) {
  for (const [field, attach] of surfaces) {
    if (context.isCurrent && !context.isCurrent()) return;
    await attach(context);
    if (context.isCurrent && !context.isCurrent()) return;
    context.onSurface?.(field);
  }
}
