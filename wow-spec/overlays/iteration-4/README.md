# Iteration 4 overlay

One patch against the World API in `wow-spec/upstream/wowapi-d39a1a0/` (WoWAPI `main` is d39a1a0):
`OpenSpatialWorld.API.yaml.patch`. It is the edit proposed upstream for iteration 4, "Portals and previews",
and it applies after the iteration 1, 2 and 3 patches. The vendored files stay unmodified.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

## What it changes

1. **Portal.destination.** The entry URL of the world the portal leads to. Its fragment MAY name where a
   visitor arrives: `#join=node.{id}`, a node of that world. Crossing MUST work as navigation to this URL. A
   portal without a destination leads nowhere: a client MUST NOT cross through it.
2. **Portal.node, User.node and View.node.** The node that places the portal, the user or the view,
   relative to the world's base URL. A `geoPose` they give is derived from that node's placement (the node's
   position in its graph, turned into a GeoPose through the graph's anchor) and MUST equal it.
3. **World.preview.** What a portal leading to this world shows: an arrival node, a radius and a preview URL,
   or an image URL, or both. The arrival node, the radius and the preview URL MUST come together. The preview
   URL MUST return a Node tree rooted at the arrival node. It MUST hold only the world's nodes within the
   radius of the arrival node, each relative to it, and only those the reader may see. Reading it MUST NOT
   create a user.
4. **A paragraph on portals** in the API's description. Crossing MUST work as plain navigation. A client
   MUST first check that the destination answers and, if it does not, MUST refuse with the reason and stay.
   Seamless crossing, with state carried across, is an OPTIONAL profile. A `geoPose` a portal, a view or a user
   gives MUST equal its node's placement. A portal MUST show its destination only as far as the destination's
   preview allows. A portal inside a preview MUST show closed.
5. **Portal events.** A paragraph in the API's description and a `PortalActivate` schema. When a visitor uses
   a portal, a world that offers an event stream MUST send `portal_activate` on it, once for each crossing,
   before the visitor navigates and before the `user_left` event for that visitor. The event MUST carry `portalId` (the id of the portal) and `userId` (the id of
   the user who crosses), besides `type`, `revision`, `time` and `urls`, as `PortalActivate` lists them; its
   `urls` name `wow/world`, which reports the revision. `PortalActivate` adds its own `required: [portalId,
   userId]` to the `Event` it extends; `Event` itself is not changed.

`required` lists: `World` keeps no required member, so a world without portals or a preview is valid.
`Portal`, `User` and `View` keep iteration 1's `[id]`: `destination` and `node` stay optional, because a portal
without a destination is valid (it leads nowhere) and a `geoPose` may place a portal, a user or a view without a
node. `World.preview` is the one object iteration 4 adds. No member is in every preview (an image-only preview
has no arrival node), so it has no single list; its `anyOf` holds the two alternatives as `required` lists:
`[node, radius_m, url]` or `[image]`. A preview with both meets both.

The World API names no path for the preview URL; each world declares its own. The lab serves it at
`{base}wow/preview`.

## Apply

Apply iterations 1, 2 and 3 first, then this, to a copy:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && (for p in wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch wow-spec/overlays/iteration-3/*.patch wow-spec/overlays/iteration-4/*.patch; do patch -d "$copy" -p1 < "$p" || exit 1; done) && echo "$copy"
```

`npm run arch-i4-proof` applies it with its own applier. It validates the patched World API against the
OpenAPI 3.0 schema (check W1). It also checks that the text offered here is the contract this lab serves and
that the world servers behave as described, `required` lists and the preview's alternatives included
(check W2), and that a crossing intent sends one `portal_activate` with what `PortalActivate` requires.
Check W3 checks the key words and the `required` lists above, on both GeoPose forms of iteration 1,
offered, served and built, and that the World API and this file each carry the BCP 14 paragraph once.
`npm run arch-overlays-proof` runs W1 to W3 with no browser.

Nothing here has been sent upstream.
