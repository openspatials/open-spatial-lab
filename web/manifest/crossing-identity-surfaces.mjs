import { DEFAULT_MAX_SUPPORTED_TRUST_TIER } from "./trust-tier.mjs";
import { emitAgentDelegationPointer, buildDelegationDemoSurface } from "./delegation-registry.mjs";
import { generateKeyPair as featureGenerateKeyPair } from "../signing/ed25519.mjs";
import { attachSignatureProfileA as featureAttachSignatureProfileA } from "../signing/um-signature-profile-a.mjs";
import { buildEntityPersonhoodDemoSurface } from "./entity-personhood.mjs";
import { makeDemoStatusAuthority as featureMakeDemoStatusAuthority, buildStatusRefDemoSurface as featureBuildStatusRefDemoSurface } from "./statusref-resolution.mjs";

export async function attachAgentDelegation({ packet, manifest, didKey }) {
  try {
    const featureSubject = manifest.subject || didKey || "did:web:demo.local:user:runtime";
    const featureNowIso = new Date().toISOString();
    const featureDelegation = emitAgentDelegationPointer({
      delegatedBy: featureSubject,
      delegateId: "did:key:z6MkWorldNavigatorAiAgent",
      delegateType: "ai-agent",
      scope: ["spatial.session", "social.messaging", "identity.attestation"],
      delegatedAt: featureNowIso,
      expiresAt: "2030-06-01T00:00:00.000Z",
    });
    const featureKeys = await featureGenerateKeyPair();
    const featureDemoManifest = await featureAttachSignatureProfileA(
      {
        "@context": "https://universalmanifest.net/ns/v0.4",
        "@id": "urn:uuid:runtime-demo-delegation",
        "@type": "um:Manifest",
        manifestVersion: "0.4",
        subject: featureSubject,
        issuedAt: featureNowIso,
        expiresAt: "2030-06-01T00:00:00.000Z",
        pointers: [featureDelegation],
      },
      featureKeys.seed,
    );
    packet.avatar_context.um_agent_delegation_v04 = await buildDelegationDemoSurface({
      manifest: featureDemoManifest,
      now: featureNowIso,
      ai_agentLabel: "ai_agent",
    });
  } catch (delErr) {
    packet.avatar_context.um_agent_delegation_v04 = { error: (delErr && delErr.message) || "agent-delegation-surface-threw" };
  }
}

export async function attachEntityPersonhood({ packet }) {
  try {
    packet.avatar_context.um_entity_personhood_v04 = await buildEntityPersonhoodDemoSurface({
      maxSupportedTrustTier: DEFAULT_MAX_SUPPORTED_TRUST_TIER,
    });
  } catch (entErr) {
    packet.avatar_context.um_entity_personhood_v04 = { error: (entErr && entErr.message) || "entity-personhood-surface-threw" };
  }
}

export function attachStatusref({ packet, manifest }) {
  try {
    const featureAuthority = featureMakeDemoStatusAuthority();
    const featureManifestId = manifest["@id"] || "urn:uuid:runtime-demo-crossing";
    featureAuthority.register(featureManifestId, { status: "active" });
    packet.avatar_context.um_statusref_v04 = featureBuildStatusRefDemoSurface({
      manifestId: featureManifestId,
      statusRef: featureAuthority.statusRefFor(featureManifestId),
      authority: featureAuthority,
      policy: "active-required",
    });
  } catch (srErr) {
    packet.avatar_context.um_statusref_v04 = { error: (srErr && srErr.message) || "statusref-surface-threw" };
  }
}
