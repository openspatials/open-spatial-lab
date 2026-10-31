# Iteration 4 overlay

One patch against the World API in `wow-spec/upstream/wowapi-d39a1a0/` (WoWAPI `main` is d39a1a0):
`OpenSpatialWorld.API.yaml.patch`. It is the edit proposed upstream for iteration 4, "Portals and previews",
and it applies after the iteration 1, 2 and 3 patches. The vendored files stay unmodified.

## What it changes

1. **Portal.destination.** The entry URL of the world the portal leads to. Its fragment may name where a
   visitor arrives: `#join=node.{id}`, a node of that world. Crossing is navigation to this URL. A portal
   without a destination leads nowhere.
2. **Portal.node, User.node and View.node.** The node that places the portal, the user or the view,
   relative to the world's base URL. A `geoPose` they give is derived from that node's placement: the node's
   position in its graph, turned into a GeoPose through the graph's anchor.
3. **World.preview.** What a portal leading to this world shows: an arrival node, a radius and a preview URL,
   or an image URL, or both. The preview URL returns a Node tree rooted at the arrival node. It holds only the
   world's nodes within the radius of the arrival node, each relative to it, and only those the reader may
   see. Reading it creates no user.
4. **A paragraph on portals** in the API's description. Crossing is plain navigation; a client first checks
   that the destination answers and, if it does not, refuses with the reason and stays. Seamless crossing,
   with state carried across, is an optional profile. A portal inside a preview shows closed.

The World API names no path for the preview URL; each world declares its own. The lab serves it at
`{base}wow/preview`.

## Apply

Apply iterations 1, 2 and 3 first, then this, to a copy:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && (for p in wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch wow-spec/overlays/iteration-3/*.patch wow-spec/overlays/iteration-4/*.patch; do patch -d "$copy" -p1 < "$p" || exit 1; done) && echo "$copy"
```

`npm run arch-i4-proof` applies it with its own applier. It validates the patched World API against the
OpenAPI 3.0 schema (check W1). It also checks that the text offered here is the contract this lab serves and
that the world servers behave as described (check W2).

Nothing here has been sent upstream.
