import { demoSealedFacetSurface as featureDemoSealedFacetSurface } from "./jwe-sealed-facets.mjs";
import { generateKeyPair as featureGenerateKeyPair } from "../signing/ed25519.mjs";
import { demoLockedFacetScenario } from "./liveness-assurance.mjs";
import { buildPrivateDataPanel } from "./private-data.mjs";
import { runFormatIndependenceScenario, buildFormatIndependencePanel } from "./cbor-ld.mjs";

export async function attachSealedFacets({ packet }) {
  try {
    packet.avatar_context.um_sealed_facets_v04 = await featureDemoSealedFacetSurface();
  } catch (sealErr) {
    packet.avatar_context.um_sealed_facets_v04 = { error: (sealErr && sealErr.message) || "sealed-facet-surface-threw" };
  }
}

export async function attachLivenessAssurance({ packet, transport }) {
  try {
    const featureDemo = await demoLockedFacetScenario({ demoUnlock: false });
    packet.avatar_context.um_liveness_assurance_v04 = featureDemo;
    transport.emitSyntheticApiRequest({
      method: "RECEIPT",
      url: featureDemo.lockedReceipt.manifestId,
      path: featureDemo.lockedReceipt.manifestId,
      status: featureDemo.lockedReceipt.outcome === "rejected" ? 403 : 200,
      ok: featureDemo.lockedReceipt.outcome !== "rejected",
      ms: 0,
      schema: `um:Receipt · ${featureDemo.lockedReceipt.outcome} · liveness/assurance floor (PREVIEW)`,
      ...featureDemo.lockedPanelRow,
    });
  } catch (livErr) {
    packet.avatar_context.um_liveness_assurance_v04 = { error: (livErr && livErr.message) || "liveness-assurance-surface-threw" };
  }
}

export function attachPrivateData({ packet, transport }) {
  try {
    const featurePanel = buildPrivateDataPanel();
    packet.avatar_context.um_private_data_v04 = featurePanel;
    for (const row of featurePanel.rows) {
      transport.emitSyntheticApiRequest({
        method: "PRIVATE-DATA",
        url: row.facet || row.facetKeyRef || featurePanel.label,
        path: row.kind,
        status: row.decision === "reject" ? 403 : 200,
        ok: row.decision !== "reject",
        ms: 0,
        schema: `um:PrivateData · ${row.code || row.kind} (PREVIEW)`,
      });
    }
  } catch (pdErr) {
    packet.avatar_context.um_private_data_v04 = { error: (pdErr && pdErr.message) || "private-data-surface-threw" };
  }
}

export async function attachFormatIndependence({ packet, manifest, didKey }) {
  try {
    const featureNow = new Date().toISOString();
    const featureKeys = await featureGenerateKeyPair();
    const featureUnsigned = {
      "@context": "https://universalmanifest.net/ns/v0.4",
      "@id": `urn:uuid:${globalThis.crypto.randomUUID()}`,
      "@type": "um:Manifest",
      manifestVersion: "0.4",
      subject: manifest.subject || didKey || "did:web:demo.local:user:runtime",
      issuedAt: featureNow,
      expiresAt: new Date(Date.parse(featureNow) + 3600_000).toISOString(),
    };
    const featureScenario = await runFormatIndependenceScenario({
      name: "portal-crossing (format independence)",
      unsignedManifest: featureUnsigned,
      evaluationContext: { now: featureNow, intendedScope: ["read"] },
      privateKeyInput: featureKeys.privateKey,
    });
    packet.avatar_context.um_format_independence_v04 = buildFormatIndependencePanel(featureScenario);
  } catch (fmtErr) {
    packet.avatar_context.um_format_independence_v04 = { error: (fmtErr && fmtErr.message) || "format-independence-surface-threw" };
  }
}
