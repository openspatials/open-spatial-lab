# Iteration 2 overlay

Two patches against the Web of Worlds files in `wow-spec/upstream/wowapi-d39a1a0/` (WoWAPI `main` is d39a1a0).
They are the edits proposed upstream for iteration 2, "Including a graph from another world". The vendored files
stay unmodified.

- `OpenSpatialWorld.API.yaml.patch` applies to the World API after iteration 1's patch
  (`../iteration-1/OpenSpatialWorld.API.yaml.patch`).
- `OpenSpatialWorld.README.md.patch` applies to `specification/OpenSpatialWorld/README.md`.

## What they change

World API:

1. **Inclusion.** `Node.spatialAssetURI` gains a description. It may name a model, or the `Spatial`, `Node` or
   `wow/world` resource of any world, which is then shown at this node. A client tells them apart by the media type
   of the answer, never by the address. The including node stands in for the included node's parent. A whole
   world shows its default graph, and its other anchored graphs where their GeoPoses put them. The included
   world's environment does not apply to the host. The host sets a nesting limit and a budget, detects cycles by
   URL, and shows a placeholder on failure. This is decision 4 (2026-10-22): the existing field carries the link,
   so no separate reference field is proposed.
2. **Graphs.** `World.spatials` lists the ids of the world's graphs, the default graph first.
3. **Media type.** Resources are served as `application/wow+json`, a working name that stays provisional until
   the group decides it. It replaces `application/json` on the eight responses that return a resource (world,
   user, view, portal, spatial, and the node POST, GET and PUT). `application/json` stays available by content
   negotiation, and the node write bodies accept both. Its fragment identifiers are JSON Pointers (RFC 6901 §6).
4. **Entity tags.** `GET /wow/world`, `GET /wow/spatial/{spatialID}` and the node GET return `ETag` and
   `Last-Modified` and answer `If-None-Match` with 304. The node PUT and DELETE honour `If-Match` and answer 412
   on a mismatch (RFC 9110).
5. **Cross-origin reads.** Responses carry `Access-Control-Allow-Origin` as the world's policy allows, and
   `Access-Control-Expose-Headers: ETag`. Preflight responses allow `Authorization`, `If-None-Match` and
   `If-Match`.

README:

- "Expose parts of scene to be linked in external world" becomes: any readable `Spatial` or `Node` may be
  included by another world. The `URL/wow/scene/` line under it is left to the path decision of the paper's
  §5.3.4.
- The base-URL rule: a world may sit at a path prefix, and its resource URLs are the base plus `wow/...`.

## Apply

Apply iteration 1's patches first, then these, to a copy:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && patch -d "$copy" -p1 < wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch && patch -d "$copy" -p1 < wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch && patch -d "$copy" -p1 < wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch && echo "$copy"
```

`npm run arch-i2-proof` applies them with its own applier. It validates the patched World API against the
OpenAPI 3.0 schema (`wow-spec/upstream/openapi-3.0/`), checks its path parameters and references (check O1),
and checks that the text offered here is the contract this lab serves and the behaviour of its world servers
(check O2).

Nothing here has been sent upstream.
