// Signed carrier manifests for the extension checks (src/wow-extension-discovery-check.mjs and
// src/wow-extension-mount-browser-check.mjs): a version 0.6 manifest with one osl:ExtensionFacet, signed with Ed25519
// over the Lab's own JCS (RFC 8785), the public key in signature.publicKeySpkiB64. The form is the one of
// docs/universal-extensions/fixtures/make-fixtures.mjs. Keys are made per run and never kept.
import { generateKeyPairSync, sign } from "node:crypto";
import { jcsCanonicalizeToBytes } from "../../../web/signing/jcs-rfc8785.mjs";

export const newCarrierKey = () => generateKeyPairSync("ed25519");

/**
 * carrierManifest({ key, id, facetId, subject, module, attach, requests, issuedAt, expiresAt }) -> the signed manifest
 * object. `key` is a node:crypto Ed25519 key pair; null leaves the manifest without a signature member.
 */
export function carrierManifest({
  key, id = "urn:uuid:check-carrier-1", facetId = "urn:osl:check:facet:1", subject = "urn:osl:check:world-node:carried",
  module, attach = { kind: "world-node" }, requests = [], issuedAt = "2026-11-16T00:00:00.000Z", expiresAt = "2030-11-16T00:00:00.000Z",
}) {
  const manifest = {
    "@context": "https://universalmanifest.net/ns/v0.6",
    "@id": id,
    "@type": "um:Manifest",
    manifestVersion: "0.6",
    subject,
    issuedAt,
    expiresAt,
    facets: [{
      "@id": facetId,
      "@type": ["um:Facet", "osl:ExtensionFacet"],
      name: "checkExtension",
      entity: {
        "@id": `${facetId}:entity`,
        "@type": ["um:Entity", "osl:Extension"],
        module,
        interface: "ue:host@0.1.0",
        attach,
        requests,
      },
    }],
  };
  if (!key) return manifest;
  const spki = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const value = sign(null, Buffer.from(jcsCanonicalizeToBytes(manifest)), key.privateKey).toString("base64url");
  return { ...manifest, signature: { algorithm: "Ed25519", canonicalization: "JCS-RFC8785", keyRef: "did:example:check-carrier#key-1", created: issuedAt, publicKeySpkiB64: spki, value } };
}
