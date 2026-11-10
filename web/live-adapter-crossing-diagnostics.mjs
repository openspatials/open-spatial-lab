import { enrichCrossingDemoSurfaces } from "./manifest/crossing-demo-surfaces.mjs";

/** Diagnostics have their own copy; arrival and broadcast payloads are immutable to this task. */
export async function publishCrossingDiagnostics(packet, { transport, isCurrent, publish }) {
  const diagnosticPacket = structuredClone(packet);
  const manifest = diagnosticPacket.avatar_context?.um_manifest_v04;
  if (!manifest?.signature?.value || !isCurrent()) return;
  const identity = {
    handoff_id: diagnosticPacket.handoff_id || null,
    manifest_id: manifest["@id"] || null,
    signature_value: manifest.signature.value,
  };
  const surfaces = {};
  const current = () => isCurrent() && (packet.handoff_id || null) === identity.handoff_id &&
    packet.avatar_context?.um_manifest_v04?.["@id"] === identity.manifest_id &&
    packet.avatar_context?.um_manifest_v04?.signature?.value === identity.signature_value;
  const report = (state, error = null) => {
    if (current()) publish({ ...identity, state, surfaces: structuredClone(surfaces), error,
      payload_scope: "local diagnostics; not added to the sent handoff packet" });
  };
  try {
    report("pending");
    await enrichCrossingDemoSurfaces({
      packet: diagnosticPacket, manifest, didKey: manifest.subject,
      transport: { emitSyntheticApiRequest(event) { if (current()) transport.emitSyntheticApiRequest(event); } },
      isCurrent: current,
      onSurface(field) {
        surfaces[field] = diagnosticPacket.avatar_context[field];
        report("pending");
      },
    });
    report(Object.values(surfaces).some(value => value?.error) ? "failed" : "complete");
  } catch (error) {
    report("failed", error?.message || "crossing-diagnostics-threw");
  }
}
