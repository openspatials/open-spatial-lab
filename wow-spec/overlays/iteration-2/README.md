# Iteration 2 overlay

Two patches against the Web of Worlds files in `wow-spec/upstream/wowapi-d39a1a0/` (WoWAPI `main` is d39a1a0).
They are the edits proposed upstream for iteration 2, "Including a graph from another world". The vendored files
stay unmodified.

- `OpenSpatialWorld.API.yaml.patch` applies to the World API after iteration 1's patch
  (`../iteration-1/OpenSpatialWorld.API.yaml.patch`).
- `OpenSpatialWorld.README.md.patch` applies to `specification/OpenSpatialWorld/README.md`.

## What they change

World API:

1. **Inclusion.** `Node.spatialAssetURI` gains a description. It MAY name a model, or the `Spatial`, `Node` or
   `wow/world` resource of any world, which is then shown at this node. A client MUST tell them apart by the media
   type of the answer, never by the address or the content: `application/wow+json` marks a Web of Worlds resource.
   The including node stands in for the included node's parent. A whole world shows its default graph, and its
   other anchored graphs where their GeoPoses put them. The included world's environment MUST NOT apply to the
   host. The host MUST set a nesting limit and a budget of included graphs, which it hands out in tree order (depth
   first, children in order). It MUST refuse an inclusion that closes a cycle, detected by URL, and SHOULD show a
   placeholder on failure. A host MUST read an included part from the part's own world, at its URL, and MUST
   revalidate it by its entity tag. A copy of that part relayed or embedded by any other world MUST NOT be shown as
   that part. When the part's own world does not answer, the host SHOULD show the placeholder. This is decision 4
   (2026-10-22): the existing field carries the link, so no separate reference field is proposed.
2. **Graphs.** `World.spatials` lists the ids of the world's graphs, the default graph first. A reader MUST treat an
   absent `spatials` as an empty list.
3. **Media type.** Resources MUST be served as `application/wow+json`, a working name that stays provisional until
   the group decides it. It is listed first, beside `application/json`, on the eight responses that return a
   resource (world, user, view, portal, spatial, and the node POST, GET and PUT). `application/json` MUST stay available by content
   negotiation, and the node write bodies accept both. Its fragment identifiers are JSON Pointers (RFC 6901 §6).
4. **Entity tags.** `GET /wow/world`, `GET /wow/spatial/{spatialID}` and the node GET MUST return `ETag` and
   `Last-Modified` and MUST answer a matching `If-None-Match` with 304, and a 304 carries the `ETag`. The node PUT
   and DELETE MUST honor `If-Match` and MUST answer 412, changing nothing, on a mismatch. A successful PUT sends no `ETag`, because the stored node is not the
   body as sent (RFC 9110 §9.3.4).
5. **Cross-origin access.** Responses MUST carry `Access-Control-Allow-Origin` as the world's policy allows, and
   `Access-Control-Expose-Headers: ETag`. Preflight responses MUST allow the methods GET, HEAD, POST, PUT and DELETE,
   and the request headers `Authorization`, `Content-Type`, `If-None-Match` and `If-Match`.

README:

- "Expose parts of scene to be linked in external world" becomes: any readable `Spatial` or `Node` may be
  included by another world. The `URL/wow/scene/` line under it stays as it is; the path a Spatial is served at
  is decided later.
- The base-URL rule: a world MAY sit at a path prefix, and its resource URLs MUST be the base plus `wow/...`.
- The scope paragraph: this API does not define rendering, physics simulation, spatial audio or input-device
  mapping; those are matters for each client and engine, and a world MAY carry such data in its assets, which this
  API carries unchanged. This paragraph rides a pull request only after the group answers the scope question.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

Iteration 2 adds no `required` member: the schemas it touches (`World`, `Node`) keep iteration 1's lists (`World`
none, `Node [id]`), and check O3 holds them so.

## Apply

Apply iteration 1's patches first, then these, to a copy:

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && patch -d "$copy" -p1 < wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch && patch -d "$copy" -p1 < wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch && patch -d "$copy" -p1 < wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch && echo "$copy"
```

`npm run arch-i2-proof` applies them with its own applier. It validates the patched World API against the
OpenAPI 3.0 schema (`wow-spec/upstream/openapi-3.0/`), checks its path parameters and references (check O1),
checks that the text offered here is the contract this lab serves and the behaviour of its world servers,
`required` lists included (check O2), and checks the key words and `required` lists above on both GeoPose forms
(check O3), that this file carries the BCP 14 paragraph above exactly once (also check O3), and that the README carries the scope paragraph exactly once on both forms (check O4).

Nothing here has been sent upstream.
