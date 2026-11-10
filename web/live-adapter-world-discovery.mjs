import { BASE_PATH, SERVER_ORIGIN } from "./base-path.mjs";
import { resolveFabricReference as resolveFabricReferenceForBase } from "./live-adapter-fabric-reference.mjs";
import { displayPath } from "./live-adapter-transport.mjs";
import { clonePosition, roundNumber, roundVec3 } from "./live-adapter-portal-geometry.mjs";

const WOW_SERVICE_TYPE = "web-of-worlds";
const WOW_SERVICE_MAP = Object.freeze({
  wow: { key: "world", param: null },
  "wow-user": { key: "user", param: "{userId}" },
  "wow-portal": { key: "portal", param: "{portalId}" },
  "wow-view": { key: "view", param: "{viewId}" },
});

export const FABRIC_PORTAL_ATTACHMENT_SUBTYPE = 255;
export function fabricChildNodes(manifest) {
  const root = manifest && manifest.data;
  return root && Array.isArray(root.Children) ? root.Children : [];
}

export function fabricNodeId(node) {
  return node && node.Head && node.Head.Self ? String(node.Head.Self) : null;
}

export function fabricNodePosition(node) {
  const t = node && node.Transform;
  return clonePosition(t && t.Position, [0, 0, 0]);
}

export function findFabricPortalAttachmentNode(manifest) {
  return (
    fabricChildNodes(manifest).find(
      (node) => node && node.Type && Number(node.Type.bSubtype) === FABRIC_PORTAL_ATTACHMENT_SUBTYPE
    ) || null
  );
}

export function findFabricPortalAttachmentNodes(manifest) {
  return fabricChildNodes(manifest).filter(
    (node) => node && node.Type && Number(node.Type.bSubtype) === FABRIC_PORTAL_ATTACHMENT_SUBTYPE
  );
}

export function findFabricActionTriggerNode(manifest) {
  return (
    fabricChildNodes(manifest).find(
      (node) =>
        node &&
        node.Resource &&
        typeof node.Resource.sReference === "string" &&
        node.Resource.sReference.startsWith("action:")
    ) || null
  );
}

export function findFabricSpawnNode(manifest) {
  const nodes = fabricChildNodes(manifest);
  return (
    nodes.find((node) => node && node.Name === "Avatar Spawn") ||
    nodes.find(
      (node) =>
        node && node.Transform && !node.Type && !(node.Resource && node.Resource.sReference)
    ) ||
    null
  );
}

export function resolveFabricReference(ref) {
  return resolveFabricReferenceForBase(BASE_PATH, ref, SERVER_ORIGIN);
}

export function authoredWowGraphEndpoint(wowWorld, base) {
  const endpoint = wowWorld?.webofworlds_extension?.authored_graph?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) return null;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${String(base || "").replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;
}

export function resolveEndpoints(rootManifest, base) {
  const services = Array.isArray(rootManifest && rootManifest.services)
    ? rootManifest.services
    : [];
  const fallback = Object.freeze({
    world: { path: `${base}/wow/world`, id: null },
    user: { path: `${base}/wow/user/1`, id: 1 },
    portal: { path: `${base}/wow/portal/1`, id: 1 },
    view: { path: `${base}/wow/view/1`, id: 1 },
  });
  const resolved = {};
  const provenance = {};
  for (const svc of services) {
    if (!svc || typeof svc.endpoint !== "string") continue;
    if (svc.type && String(svc.type) !== WOW_SERVICE_TYPE) continue;
    const mapping = WOW_SERVICE_MAP[String(svc.name)];
    if (!mapping) continue;
    let endpoint = svc.endpoint;
    let id = null;
    if (mapping.param) {
      id = svc.default_id != null ? svc.default_id : 1;
      endpoint = endpoint.replace(mapping.param, String(id));
    }
    const path = endpoint.startsWith("/") ? `${base}${endpoint}` : `${base}/${endpoint}`;
    resolved[mapping.key] = { path, id };
    provenance[mapping.key] = {
      source: "services[]",
      service_name: svc.name,
      template: svc.endpoint,
      default_id: svc.default_id != null ? svc.default_id : null,
      resolved_id: id,
      resolved_path: displayPath(path),
    };
  }
  return endpointResolution(base, services, resolved, provenance, fallback);
}

export function fabricSummary(url, manifest) {
  const nodes = fabricChildNodes(manifest);
  const trust = manifest && manifest.trust ? manifest.trust : {};
  const camera = manifest && manifest.primary && manifest.primary.camera ? manifest.primary.camera : null;
  return {
    url: url || null,
    container: manifest && manifest.container ? manifest.container : null,
    format: trust.format || "plain-json",
    signed: trust.signed === true,
    trust_note: trust.note || "unsigned local demonstration fabric (claim boundary)",
    node_count: nodes.length,
    node_names: nodes.map((node) => node && node.Name).filter(Boolean),
    services: Array.isArray(manifest && manifest.services)
      ? manifest.services.map((svc) => ({ name: svc.name, type: svc.type, endpoint: svc.endpoint }))
      : [],
    primary_camera: camera
      ? {
          position: roundVec3(camera.position, 4),
          rotation: Array.isArray(camera.rotation) ? camera.rotation.slice(0, 4) : [0, 0, 0, 1],
          yaw_radians: yawFromQuaternionY(camera.rotation),
        }
      : null,
    background: manifest && manifest.primary ? manifest.primary.background || null : null,
    status: "loaded",
    loaded_at: new Date().toISOString(),
  };
}

export function yawFromQuaternionY(q) {
  if (!Array.isArray(q) || q.length < 4) return 0;
  const y = Number(q[1]) || 0;
  const w = Number(q[3]) || 0;
  return roundNumber(2 * Math.atan2(y, w), 6);
}

function endpointResolution(base, services, resolved, provenance, fallback) {
  const out = {};
  for (const key of ["world", "user", "portal", "view"]) {
    if (resolved[key]) {
      out[key] = resolved[key];
    } else {
      out[key] = { ...fallback[key] };
      provenance[key] = {
        source: "fallback_constant",
        service_name: null,
        template: null,
        default_id: null,
        resolved_id: fallback[key].id,
        resolved_path: displayPath(fallback[key].path),
      };
    }
  }
  return {
    base,
    endpoints: out,
    provenance,
    services_present: services.length > 0,
    resolved_from_services: Object.values(provenance).some((p) => p.source === "services[]"),
    resolution_rule:
      "fabric services[] endpoint templates resolved against the manifest base; " +
      "{userId}/{portalId}/{viewId} filled from default_id (WoW integer spec routes)",
  };
}
