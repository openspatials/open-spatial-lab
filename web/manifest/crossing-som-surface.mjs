import { DEFAULT_MAX_SUPPORTED_TRUST_TIER } from "./trust-tier.mjs";
import { generateKeyPair as featureGenerateKeyPair } from "../signing/ed25519.mjs";
import { buildProofShapesDemoSurface } from "./zkp-ceremony.mjs";
import { runFactoryFloorSomDemo, somGatingPanelRecord, feature_SOM_CONFORMANCE } from "./som-branch-auth.mjs";

export function attachHigherTierProofs({ packet }) {
  try {
    packet.avatar_context.um_higher_tier_proofs_v04 = buildProofShapesDemoSurface({
      maxSupportedTrustTier: DEFAULT_MAX_SUPPORTED_TRUST_TIER,
    });
  } catch (zkpErr) {
    packet.avatar_context.um_higher_tier_proofs_v04 = { error: (zkpErr && zkpErr.message) || "higher-tier-validation-surface-threw" };
  }
}

export async function attachRp1SomGating({ packet, transport }) {
  try {
    const featureKeys = await featureGenerateKeyPair();
    const featureDemo = await runFactoryFloorSomDemo({ privateKeyInput: featureKeys.privateKey, now: new Date().toISOString() });
    const featurePanel = somGatingPanelRecord(featureDemo.session, { chainReport: featureDemo.sealed && featureDemo.sealed.chainReport });
    packet.avatar_context.um_rp1_som_gating_v04 = {
      panel: featurePanel,
      bucket: feature_SOM_CONFORMANCE.bucket,
      cross_branch_write_blocked: featureDemo?.writes?.crossBranchBlocked?.allowed === false,
      hazard_reroute_delivered: featureDemo?.messages?.hazardReroute?.delivered === true,
      ad_push_refused: featureDemo?.messages?.adPushRefused?.allowed === false,
      chain_verified: !!(featureDemo.sealed && featureDemo.sealed.chainReport && featureDemo.sealed.chainReport.valid),
      um_conformance_claimed: false,
      claim_label: feature_SOM_CONFORMANCE.claim_label,
    };
    transport.emitSyntheticApiRequest({
      method: "RP1-SOM",
      url: (featureDemo.session && featureDemo.session.hashChain && featureDemo.session.hashChain.chainId) || "R6+R7",
      path: "R6+R7",
      status: featureDemo?.writes?.crossBranchBlocked?.allowed === false && featureDemo?.messages?.hazardReroute?.delivered === true ? 200 : 500,
      ok: !!(featureDemo.sealed && featureDemo.sealed.chainReport && featureDemo.sealed.chainReport.valid) &&
        featureDemo?.writes?.crossBranchBlocked?.allowed === false &&
        featureDemo?.messages?.adPushRefused?.allowed === false,
      ms: 0,
      schema: `rp1:SOMBranchAuthorization+rp1:InterServiceAuthorization · ${feature_SOM_CONFORMANCE.bucket}`,
      ...featurePanel,
    });
  } catch (somErr) {
    packet.avatar_context.um_rp1_som_gating_v04 = { error: (somErr && somErr.message) || "rp1-som-gating-surface-threw" };
  }
}
