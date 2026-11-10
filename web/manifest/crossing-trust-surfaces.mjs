import { buildTierDemoSurface, DEFAULT_MAX_SUPPORTED_TRUST_TIER } from "./trust-tier.mjs";
import { issueVerifierChallenge as featureIssueVerifierChallenge, evaluateHolderBinding as featureEvaluateHolderBinding } from "./holder-binding.mjs";
import { createReceipt as featureCreateReceipt, mergeFragment as featureMergeFragment, finalizeReceipt as featureFinalizeReceipt, receiptPanelRecord as featureReceiptPanelRecord } from "./receipt-hub.mjs";

export function attachTrustTier({ packet, manifest }) {
  try {
    packet.avatar_context.um_trust_tier_v04 = buildTierDemoSurface({
      localRequiredTrustTier: manifest.requiredTrustTier ?? 0,
      remoteRequiredTrustTier: 0,
      maxSupportedTrustTier: DEFAULT_MAX_SUPPORTED_TRUST_TIER,
    });
  } catch (tierErr) {
    packet.avatar_context.um_trust_tier_v04 = { error: (tierErr && tierErr.message) || "tier-surface-threw" };
  }
}

export async function attachHolderBinding({ packet, manifest }) {
  try {
    const featureChallenge = featureIssueVerifierChallenge({
      audience: `did:web:${(packet.target && packet.target.location_id) || "destination"}`,
    });
    const featureEval = await featureEvaluateHolderBinding(manifest, {
      now: new Date().toISOString(),
      maxSupportedTrustTier: DEFAULT_MAX_SUPPORTED_TRUST_TIER,
    });
    packet.avatar_context.um_holder_binding_v04 = {
      challenge_issued: featureChallenge.verifierChallenge,
      challenge_audience: featureChallenge.verifierAudience,
      offline_evaluation: {
        outcome: featureEval.receipt.outcome,
        signature_check: featureEval.receipt.signatureCheck,
        freshness_check: featureEval.receipt.freshnessCheck,
        key_ref_resolution: featureEval.receipt.keyRefResolution,
        presentation_proof_status: featureEval.receipt.presentationProofStatus || "not-challenged-offline",
        holder_binding_status: featureEval.receipt.holderBindingStatus || "absent",
      },
      um_conformance_claimed: false,
      note: "runtime holder-binding/presentation-validation evaluator surface (offline posture; interactive did-auth attach + replay-reject proven in runtime-verify.mjs). NOT full evaluator conformance.",
    };
  } catch (hbErr) {
    packet.avatar_context.um_holder_binding_v04 = { error: (hbErr && hbErr.message) || "holder-binding-surface-threw" };
  }
}

export async function attachReceipt({ packet, manifest, transport }) {
  try {
    const featureEval = await featureEvaluateHolderBinding(manifest, {
      now: new Date().toISOString(),
      maxSupportedTrustTier: DEFAULT_MAX_SUPPORTED_TRUST_TIER,
    });
    const featureReceipt = featureCreateReceipt({ manifestId: manifest["@id"] || undefined });
    featureMergeFragment(featureReceipt, featureEval.receipt);
    featureFinalizeReceipt(featureReceipt, { now: new Date().toISOString() });
    const featurePanel = featureReceiptPanelRecord(featureReceipt, { label: "portal crossing" });
    packet.avatar_context.um_receipt_v04 = {
      receipt: featureReceipt,
      panel: featurePanel,
      um_conformance_claimed: false,
      note: "canonical um:Receipt composed from the runtime crossing evaluation via the runtime hub (createReceipt/mergeFragment/finalizeReceipt). NOT a full evaluator-conformance claim; full matrix is runtime.",
    };
    transport.emitSyntheticApiRequest({
      method: "RECEIPT",
      url: featureReceipt.manifestId,
      path: featureReceipt.manifestId,
      status: featureReceipt.outcome === "rejected" ? 403 : 200,
      ok: featureReceipt.outcome !== "rejected",
      ms: 0,
      schema: `um:Receipt · ${featureReceipt.outcome}`,
      ...featurePanel,
    });
  } catch (rcptErr) {
    packet.avatar_context.um_receipt_v04 = { error: (rcptErr && rcptErr.message) || "receipt-surface-threw" };
  }
}
