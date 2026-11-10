import { readRootFabric, readPortals, readSceneGraph } from "./live-adapter-world-reader.mjs";
import { resolveEndpoints, authoredWowGraphEndpoint } from "./live-adapter-world-discovery.mjs";
import { worldFromLive, wowWorldSpatialId } from "./live-adapter-world-projection.mjs";
import { portalSignature } from "./main-demo-portals.mjs";

export async function readNavigationDestination({ endpoint, role, transport, isCurrent }) {
  const destination = await readNavigationResources({ endpoint, role, transport, isCurrent });
  if (!destination || !isCurrent()) return null;
  const { base, wowWorld, messages } = destination;
  const authoredEndpoint = authoredWowGraphEndpoint(wowWorld, base);
  const scene = await readSceneGraph({ base, spatialId: wowWorldSpatialId(wowWorld), graphEndpoint: authoredEndpoint,
    resolvedFrom: authoredEndpoint
      ? "crossing destination backend-advertised authored /wow/graph (reached via Portal.destination; confirmed vs promoted /wow/world)"
      : "crossing destination /wow/spatial (reached via source portal Portal.destination; confirmed vs promoted /wow/world)",
  }, { transport, onLog: message => messages.push(message) });
  return isCurrent() ? { ...destination, scene } : null;
}

export async function readNavigationResources({ endpoint, role, transport, isCurrent }) {
  const base = endpoint.proxy_base;
  const rootFabric = await readRootFabric(base, transport);
  if (!isCurrent()) return null;
  const resolution = resolveEndpoints(rootFabric, base);
  const wowWorld = await transport.getJson(resolution.endpoints.world.path);
  if (!isCurrent()) return null;
  const messages = [];
  const onLog = message => messages.push(message);
  const portals = await readPortals(base, wowWorld, { transport, onLog });
  if (!isCurrent()) return null;
  const world = worldFromLive(role, wowWorld, portals, null);
  return { endpoint, base, world, wowWorld, rootFabric, resolution, portals, messages,
    portalSignature: portalSignature(portals),
    portalId: portals[0]?.webofworlds_extension?.portal_id || endpoint.portal_id };
}

export function promotionRecord({ navigator, world, previousRootContainer, packet, marker, prefetch }) {
  return {
    promoted_root_container: navigator?.root_fabric ? navigator.root_fabric.container : world.location_id,
    demoted_root_container: previousRootContainer, handoff_id: packet?.handoff_id || null,
    context_id: marker?.context_id || null, single_context: true,
    mechanism: "child fabric promoted to the root frame of the SAME context; previous root disconnected and re-attached as child at the promoted fabric's portal-back node",
    promoted_at: new Date().toISOString(), promoted_with_prefetch: !!prefetch?.used,
    fabric_prefetch_at_promotion: prefetch || null,
  };
}
