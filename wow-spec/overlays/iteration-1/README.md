# Iteration 1 overlay

Two patches against the Web of Worlds API descriptions in `wow-spec/upstream/wowapi-d39a1a0/`. They are
the edits proposed upstream. The vendored files stay unmodified.

- `OpenSpatialWorld.API.yaml.patch`
- `OpenSpatialAsset.API.yaml.patch`

## Two forms of the GeoPose text

How the GeoPose angles turn a Spatial's frame is an open question. Both forms are kept, and either can be offered:

- **With the rotation sentences** (the two patches in this folder). The GeoPose description says the angles are
  "applied about the local axes z, y and x in that order", and the frame paragraph says that "at zero angles +X is
  east, +Y up and +Z south". The served contract `wow-spec/schema.yaml` carries this form.
- **Without the rotation sentences** (`without-rotation-sentences/`, the same two file names). The GeoPose
  description says the angles are applied "as OGC GeoPose 1.0 Basic-YPR defines them", and the frame paragraph
  ends at "A Spatial's GeoPose anchors its origin."

The two forms differ in those two sentences only. Everything else, the BCP 14 paragraph, the key words and the
`required` lists included, is the same text. Check U5 of `npm run arch-i1-proof` holds them to that.

## What they change

World API:

1. **GeoPose.** One `components.schemas.GeoPose` (OGC GeoPose 1.0 Basic-YPR) replaces the five inline
   `geoPose` objects. Longitude is `lon`; `lan` is a deprecated alias. `World.geoPose` is described as the
   world's location for discovery, not a placement.
2. **Transform.** `Node.localTransform` is 16 items, with a description of the column-major 4×4 matrix.
3. **Tree.** `Node.id`, `Node.parent` and `Node.children` say that an id is unique within the world and
   never reused, that a node has one parent, that `children` is derived, and that a PUT of `parent` moves a node.
4. **Frames.** `info.description` states the frame: meters, right-handed, +Y up, anchored by the Spatial's GeoPose.
5. **Errata.** `spatialID` is declared on the four node operations, and the DELETE parameter `nodeid` is
   renamed `nodeId`. An OpenAPI linter reports no undeclared path parameter afterwards.
6. **Spatial ids.** `Spatial.id` and `Spatial.rootNodeID` are integers, as the `spatialID` path parameter is.
7. **Conformance vocabulary.** `info.description` carries the BCP 14 paragraph of RFC 8174, citing RFC 2119
   and RFC 8174, and every normative sentence above uses a key word: coordinates MUST be in meters,
   right-handed, +Y up; a writer MUST send `lon` and a reader MUST accept `lan`; `localTransform` MUST be 16
   numbers and MUST decompose with no shear; a server MUST NOT change `children` on a PUT, MUST NOT reuse a
   node id, and MUST refuse a move that makes a loop. The schemas carry `required` lists: `GeoPose [position,
   angles]` (as before), `Spatial [id, rootNodeID]`, `Node [id]`, `User [id]`, `View [id]` and `Portal [id]`.
   `World` has no required member. `Node.id` is `readOnly`, so, as OpenAPI 3.0.3 defines, it is required in
   responses only: a create body carries no id. `localTransform` stays optional, because a PUT may change one
   member.
8. **Extent.** `Spatial.extent` (optional) is `{min, max}`, each three numbers: the box the graph occupies, in
   meters, in the graph's frame. On every axis, `min` MUST NOT exceed `max`. A reader MUST treat an extent whose
   `min` exceeds `max` as absent. No request carries an extent, so the rule is stated for the one who serves it
   and for the one who reads it. Check X1 of `npm run arch-i1-proof` holds both forms, the served contract, the
   world server and the client's reader of the Spatial resource to it.

Asset API: `info.description` carries the same BCP 14 paragraph. `Asset.geoPose` uses the same GeoPose
definition, and is described as metadata that a host MAY use to choose a placement and that MUST NOT override
one. `Asset` has no required member.

## Apply

Apply them to a copy, so the vendored files stay as upstream wrote them (for the other form, use the patches in
`without-rotation-sentences/`):

```bash
copy=$(mktemp -d) && cp -R wow-spec/upstream/wowapi-d39a1a0/. "$copy" && patch -d "$copy" -p1 < wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch && patch -d "$copy" -p1 < wow-spec/overlays/iteration-1/OpenSpatialAsset.API.yaml.patch && echo "$copy"
```

`git apply --directory` works too. `npm run arch-i1-proof` applies both patches with its own small applier,
checks the result (check U1), and checks that the text offered here is the contract this lab serves and
proves (check U2). Check U3 checks the conformance vocabulary: the BCP 14 paragraph, the key words and the
`required` lists, and that every world server the proof starts serves what those lists require. U1 and U3 run on both forms. Check U5
checks that both forms apply, that they differ in exactly the two rotation sentences, and that each equals the
served contract: the with-form as served, the without-form with the two sentences taken out.
