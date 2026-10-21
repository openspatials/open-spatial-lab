/**
 * wow-spec shared TypeScript surface.
 *
 * Ergonomic named re-exports of the openapi-typescript-generated contract
 * types, so the OSL server (runtime/041) and client (web/live-adapter.js)
 * single-source ONE set of types from `schema.yaml`. Consume from JS via JSDoc
 * without a TS migration, e.g.:
 *
 *   // @ts-check
 *   \@typedef {import('../wow-spec/types').OSLWorldResponse} OSLWorldResponse
 *
 * Regenerate the underlying types with: `npm run wow-types`.
 */

import type { components, paths, operations } from "./generated/wow-types";

// Re-export the raw generated surfaces.
export type { components, paths, operations };

// ---- CANONICAL OpenSpatialWorld schemas (transcribed from the open spec) ----
export type GeoPose = components["schemas"]["GeoPose"];
export type World = components["schemas"]["World"];
export type User = components["schemas"]["User"];
export type View = components["schemas"]["View"];
export type Portal = components["schemas"]["Portal"];
/**
 * The CANONICAL node: `children` are EMBEDDED `Node` objects (recursive), per
 * the open spec. NOTE: OSL does NOT serve this shape — the /wow/spatial/* paths
 * serve the LABELED `OSLFlatNode` (integer id-ref children). Use `OSLFlatNode`
 * for anything that touches the OSL server or client; use `Node` only when you
 * mean the standard itself. See OSL-WOW-CONTRACT.md §9.
 */
export type Node = components["schemas"]["Node"];
/** The CANONICAL graph descriptor {id, rootNodeID, geoPose}. Not yet served (D3). */
export type Spatial = components["schemas"]["Spatial"];

// ---- LABELED OSL extensions (non-canonical) ----
export type ProofBoundary = components["schemas"]["ProofBoundary"];
export type PortalDestination = components["schemas"]["PortalDestination"];
/**
 * The node shape OSL ACTUALLY serves/renders: a FLAT graph node whose `children`
 * are INTEGER id references. A DECLARED, LABELED divergence from the canonical
 * `Node` (which embeds child objects). Surfaced by the conformance lane.
 */
export type OSLFlatNode = components["schemas"]["OSLFlatNode"];
/**
 * The LABELED contract that makes a WoW node TRANSCLUDE a signed `.msf` spatial
 * fabric as a verifiable SUBTREE (the subtree analogue of the node's glTF LEAF).
 * Carried at `node.webofworlds_extension.spatial_fabric_subtree`.
 *
 * TRANSCLUSION, not traversal: `<img src>`, not `<a href>`. The fabric is drawn
 * HERE, in this node's own frame — nobody travels to it. Traversal is
 * `PortalDestination`, and the two are deliberately NOT merged.
 *
 * `spatialAssetURI` is the ADDRESS (spec-legal: the canonical `Node` types it as a
 * bare string); THIS is the CONTRACT (labeled ours). `unitsPerMeter`, `upAxis` and
 * `placement` are REQUIRED and have NO DEFAULTS. Declared divergence D8;
 * `standards_conformance` stays `false`. See OSL-WOW-CONTRACT.md §9.
 */
export type SpatialFabricSubtree = components["schemas"]["SpatialFabricSubtree"];
export type Zone = components["schemas"]["Zone"];
export type PortalTraversal = components["schemas"]["PortalTraversal"];
export type WebOfWorldsExtension = components["schemas"]["WebOfWorldsExtension"];

// ---- OSL response composites (canonical + labeled extensions) ----
// These are what the OSL 041 server actually returns and what response
// validation checks against.
export type OSLWorldResponse = components["schemas"]["OSLWorldResponse"];
export type OSLUserResponse = components["schemas"]["OSLUserResponse"];
export type OSLViewResponse = components["schemas"]["OSLViewResponse"];
export type OSLPortalResponse = components["schemas"]["OSLPortalResponse"];
