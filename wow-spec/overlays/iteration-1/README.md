# Iteration 1 overlay

Two patches against the Web of Worlds API descriptions in `wow-spec/upstream/wowapi-d39a1a0/`. They are
the edits proposed upstream. The vendored files stay unmodified.

- `OpenSpatialWorld.API.yaml.patch`
- `OpenSpatialAsset.API.yaml.patch`

## What they change

World API:

1. **GeoPose.** One `components.schemas.GeoPose` (OGC GeoPose 1.0 Basic-YPR) replaces the five inline
   `geoPose` objects. Longitude is `lon`; `lan` is a deprecated alias. `World.geoPose` is described as the
   world's location for discovery, not a placement.
2. **Transform.** `Node.localTransform` is 16 items, with a description of the column-major 4×4 matrix.
3. **Tree.** `Node.id`, `Node.parent` and `Node.children` say that an id is unique within the world and
   never reused, that a node has one parent, that `children` is derived, and that a PUT of `parent` moves a node.
4. **Frames.** `info.description` states the frame: metres, right-handed, +Y up, anchored by the Spatial's GeoPose.
5. **Errata.** `spatialID` is declared on the four node operations, and the DELETE parameter `nodeid` is
   renamed `nodeId`. An OpenAPI linter reports no undeclared path parameter afterwards.
6. **Spatial ids.** `Spatial.id` and `Spatial.rootNodeID` are integers, as the `spatialID` path parameter is.

Asset API: `Asset.geoPose` uses the same GeoPose definition, and is described as metadata that a host may use
to choose a placement and that never overrides one.

## Apply

Apply them to a copy, so the vendored files stay as upstream wrote them:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && patch -d "$copy" -p1 < wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch && patch -d "$copy" -p1 < wow-spec/overlays/iteration-1/OpenSpatialAsset.API.yaml.patch && echo "$copy"
```

`git apply --directory` works too. `npm run arch-i1-proof` applies both patches with its own small applier,
checks the result (check U1), and checks that the text offered here is the contract this lab serves and
proves (check U2).
