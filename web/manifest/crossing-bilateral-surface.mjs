import { generateKeyPair as featureGenerateKeyPair } from "../signing/ed25519.mjs";
import { attachSignatureProfileA as featureAttachSignatureProfileA } from "../signing/um-signature-profile-a.mjs";
import { createReceipt as featureCreateReceipt, mergeFragment as featureMergeFragment, finalizeReceipt as featureFinalizeReceipt } from "./receipt-hub.mjs";
import { conductBilateralExchange, verifyReceiptChain as featureVerifyReceiptChain, correlateReceiptPair, buildSealedDepartureManifest, bilateralPanelRecord } from "./bilateral-chain.mjs";
import { createReceiptChain as featureCreateEventChain, appendChainEvent as featureAppendChainEvent, sealReceiptChain as featureSealEventChain } from "./receipt-hub.mjs";
import { derivePublicKeyRaw as featureDerivePublicKeyRaw } from "../signing/ed25519.mjs";
import { publicKeyToDidKey as featurePublicKeyToDidKey } from "../signing/did.mjs";
import { verifyManifestProfileA as featureVerifyManifestProfileA } from "../signing/um-signature-profile-a.mjs";

async function makeParty(tier, featureNow) {
  const kp = await featureGenerateKeyPair();
  const partyDid = featurePublicKeyToDidKey(await featureDerivePublicKeyRaw(kp.privateKey));
  const partyManifest = await featureAttachSignatureProfileA(
    {
      "@context": "https://universalmanifest.net/ns/v0.4",
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: "0.4",
      subject: partyDid,
      issuedAt: featureNow,
      expiresAt: new Date(Date.parse(featureNow) + 3600_000).toISOString(),
      ...(tier !== undefined ? { requiredTrustTier: tier } : {}),
    },
    kp.privateKey
  );
  return { did: partyDid, manifest: partyManifest, privateKeyInput: kp.privateKey };
}

function evaluator(declaredEffectiveTier) {
  return async (counterpartyManifest, { now }) => {
    const r = featureCreateReceipt({ manifestId: counterpartyManifest["@id"] });
    const sig = await featureVerifyManifestProfileA(counterpartyManifest);
    r.signatureCheck = sig.ok
      ? "valid"
      : sig.reason === "unsupported-profile"
        ? "unsupported-profile"
        : sig.reason === "missing-signature"
          ? "missing"
          : "invalid";
    const nowMs = Date.parse(now);
    r.freshnessCheck =
      Date.parse(counterpartyManifest.issuedAt) > nowMs
        ? "stale"
        : Date.parse(counterpartyManifest.expiresAt) < nowMs
          ? "expired"
          : "fresh";
    if (Number.isInteger(declaredEffectiveTier)) featureMergeFragment(r, { effectiveTrustTier: declaredEffectiveTier });
    return featureFinalizeReceipt(r, { rejected: !sig.ok || r.freshnessCheck !== "fresh", now });
  };
}

async function verifyDeparture(featureVisitor, featureCrossing, featureNow) {
  const featureEventChain = featureCreateEventChain({ subject: featureVisitor.did });
  featureAppendChainEvent(featureEventChain, { eventClass: "session-admitted", subject: featureVisitor.did, reason: "bilateral-authorisation-completed" });
  featureAppendChainEvent(featureEventChain, { eventClass: "cross-fabric-portal-cleared", subject: featureVisitor.did, reason: "portal-crossing-cleared" });
  featureAppendChainEvent(featureEventChain, { eventClass: "departure", subject: featureVisitor.did, reason: "session-completed" });
  featureSealEventChain(featureEventChain, { at: featureNow });
  const featureDeparture = await buildSealedDepartureManifest({
    eventChain: featureEventChain,
    hashChain: featureCrossing.chain,
    subject: featureVisitor.did,
    issuedAt: featureNow,
    privateKeyInput: featureVisitor.privateKeyInput,
  });
  const featureSealedEntity = featureDeparture.facets[0].entity;
  const featureChainReport = await featureVerifyReceiptChain(featureCrossing.chain, {
    expectChainId: featureCrossing.session.sessionId,
    expectHead: { headSeq: featureSealedEntity.seq, headHash: featureSealedEntity.prevHash },
  });
  return { featureDeparture, featureChainReport };
}

export async function attachBilateralSession({ packet, transport }) {
  try {
    const featureNow = new Date().toISOString();
    const featureVisitor = await makeParty(undefined, featureNow); // visitor: no floor of its own
    const featureWorld = await makeParty(1, featureNow); // world demands Tier 1
    const featureCrossing = await conductBilateralExchange({
      initiator: { ...featureVisitor, evaluateCounterparty: evaluator(1) },
      responder: { ...featureWorld, evaluateCounterparty: evaluator(1) },
      now: featureNow,
      ttlSeconds: 3600,
    });
    const { featureDeparture, featureChainReport } = await verifyDeparture(featureVisitor, featureCrossing, featureNow);
    const featurePair = correlateReceiptPair(
      [featureCrossing.receipts.byInitiator, featureCrossing.receipts.byResponder],
      featureCrossing.exchangeId
    );
    const featurePanel = bilateralPanelRecord(featureCrossing.session, {
      floor: featureCrossing.floor,
      admission: featureCrossing.admission,
      chainReport: featureChainReport,
    });
    packet.avatar_context.um_bilateral_session_v04 = bilateralSurface(featureCrossing, featureDeparture, featureChainReport, featurePair, featurePanel);
    transport.emitSyntheticApiRequest({
      method: "BILATERAL",
      url: featureCrossing.session.sessionId,
      path: featureCrossing.exchangeId,
      status: featureCrossing.admitted ? 200 : 403,
      ok: featureCrossing.admitted,
      ms: 0,
      schema: `um:BilateralSession · ${featureCrossing.session.state} · chain ${featureChainReport.valid ? "verified" : "BROKEN"}`,
      ...featurePanel,
    });
  } catch (bilErr) {
    packet.avatar_context.um_bilateral_session_v04 = { error: (bilErr && bilErr.message) || "bilateral-session-surface-threw" };
  }
}

function bilateralSurface(featureCrossing, featureDeparture, featureChainReport, featurePair, featurePanel) {
  return {
    panel: featurePanel,
    admitted: featureCrossing.admitted,
    exchangeId: featureCrossing.exchangeId,
    chain_verified: featureChainReport.valid,
    head_anchor: "SIGNED departure-facet seal (expectHead) — V1 tail-truncation protection live",
    correlated_pair_found: featurePair.ok && featurePair.found === 2,
    departure_manifest_id: featureDeparture["@id"] || null,
    um_conformance_claimed: false,
    note: "runtime bilateral crossing: paired receipts + Profile-A-signed hash chain (chainId = sessionId), head pinned to the SIGNED departure-facet seal. EXT-OPT O3/O4 PREVIEW; Base §4 fields not preview. Authoritative gate runtime-verify.mjs.",
  };
}
