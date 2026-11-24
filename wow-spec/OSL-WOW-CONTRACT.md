# The Lab's Web of Worlds contract (wow-spec)

This file describes the Web of Worlds surface that the Lab's world servers serve. It has four parts:

- **the canonical surface**: what the Lab takes from the OpenSpatialWorld API, pinned to upstream
  `WoWAPI@d39a1a0` (§3);
- **the overlays offered upstream**: iterations 1 to 5, each a set of proposed edits to the upstream text,
  served by the Lab and proven by a named proof (§9, D9 to D13);
- **the labeled Lab extensions**: additions the standard does not state, each marked `x-osl-extension: true`
  (§4, §5, §11);
- **the declared divergences**: each place where the Lab does not match the standard (§9, D1 to D14).

`wow-spec/schema.yaml` is the served contract. This file explains it. When the two differ, `schema.yaml` is
what the server enforces (§7), and this file is wrong.

---

## 1. Files

| File | Role |
|---|---|
| `wow-spec/schema.yaml` | The served contract. OpenAPI 3.0.4. Canonical schemas, the overlay text (`x-osl-overlay: iteration-N`) and the labeled extensions (`x-osl-extension: true`). Edited by hand. |
| `wow-spec/generated/schema.json` | `schema.yaml` built as JSON (`npm run wow-schema-json`). The server's enforcer and the validator load this file. |
| `wow-spec/upstream/wowapi-d39a1a0/` | Unmodified copies of the upstream API descriptions and the World README, with their hashes in `SOURCE.json`. |
| `wow-spec/overlays/iteration-1/` to `iteration-5/` | The overlays: patches against the upstream copies, and a README per iteration. Iterations 1 and 2 also have a `without-rotation-sentences/` form (D9, item 8). |
| `wow-spec/validate.js` | The ajv validation layer. |
| `wow-spec/index.js` | Public entry: `apiSpecPath`, `schemaJsonPath`, `createValidator`, `getValidator`. |
| `wow-spec/types.d.ts` | Named TypeScript types (`World`, `Node`, `OSLWorldResponse`, `SpatialExtent`, …), written by hand. No file in `runtime/` or `web/` imports it. |
| `wow-spec/generated/wow-types.d.ts` | TypeScript types built from `schema.yaml` by openapi-typescript (`npm run wow-types`). `wow-spec/types.d.ts` imports it. |
| `wow-spec/context/wow.context.jsonld` | The JSON-LD context served at `/wow/context.jsonld` (D11). |
| `wow-spec/conformance-fixtures/run.mjs` | Contract fixtures (`npm run conformance:fixtures`). |
| `wow-spec/proof/roundtrip.js` | The contract foundation proof: projections and live responses validate, bad payloads are refused. |
| `tools/wow-conformance/` | The conformance corpus (§12). |

## 2. Commands

Run every command from the code root. A command that starts a browser runs through the browser wrapper:

```bash
HEAVY_RUN_SLOT_COUNT=2 bash ../demo-servers/browser-run.sh <command>
```

Build:

```bash
npm run wow-schema-json            # schema.yaml -> generated/schema.json
npm run wow-types                  # schema.yaml -> generated/wow-types.d.ts (openapi-typescript 7.4.4)
```

Run `npm run wow-schema-json` and `npm run wow-types` after every change to `schema.yaml`. The overlay checks compare
`generated/schema.json` with `schema.yaml` and fail when it is not rebuilt.

Proofs (each prints `N/N checks pass; M mutants, all red where the check holds` and `PASS` when it holds; every
check has planted faults that must turn it red):

```bash
npm run arch-i1-proof              # iteration 1 (D9)
npm run arch-i2-proof              # iteration 2 (D10); browser checks I11, I13, I14, I15
npm run arch-i3-proof              # iteration 3 (D11); browser check O8
npm run arch-i4-proof              # iteration 4 (D12); browser check R1
npm run arch-i5-proof              # iteration 5 (D13); browser checks V1, SE1, SE5, SE6, ID11, RB11
npm run arch-overlays-proof        # the overlay text of iterations 1 to 5, on both GeoPose forms
```

The conformance corpus (§12):

```bash
node tools/wow-conformance/run.js                   # fixtures and the endpoint pass against a world it starts
node tools/wow-conformance/run.js --base <url> [--writes] [--lab-crossing] [--out <file>]
npm run proof:corpus                                # proves that --base works and can fail
```

The world-server tests, one at a time:

```bash
node tools/run-checks.mjs test --only=<file>
```

The files are `acceptance.test.js`, `airport-backend-proof.js`, `contract-enforcement-proof.js`,
`p1-shared-edge-portal-identity-proof.js`, `spatial-graph-proof.js` and `ws-events-presence-proof.js`, all in
`runtime/world-server/test/`.

## 3. Canonical surface

The Lab follows the open OpenSpatialWorld API at upstream `WoWAPI@d39a1a0` (`wow-spec/upstream/wowapi-d39a1a0/`).

- **Schemas:** `GeoPose`, `World`, `User`, `View`, `Portal`, `Node`, `Spatial`. `GeoPose` is one shared schema;
  the standard repeats the same shape inline. The iteration 1 overlay spells longitude `lon` and reads `lan` as
  deprecated (D9).
- **Paths:** `GET /wow/world`, `GET|DELETE /wow/user/{userId}`, `GET /wow/view/{viewId}`,
  `GET /wow/portal/{portalId}`, and the Spatial Composition Graph: `GET /wow/spatial/{spatialID}` and
  `GET|POST|PUT|DELETE /wow/spatial/{spatialID}/node/{nodeId}`. The Lab uses the standard's node path. The
  `simpleWorlds` reference implementation serves `/wow/scene/node/{nodeId}` instead; the Lab does not follow it.
- **Openness:** the canonical schemas set no `additionalProperties: false`, as the standard does not. The labeled
  extensions use that openness.
- **Every contracted method is served.** Node `DELETE` removes the node and its subtree
  (`200 {ok:true, deleted:[…], count:N}`) and refuses the root with `400 cannot_delete_root`
  (`runtime/world-server/test/spatial-graph-proof.js`, checks D6 and D8). `DELETE /wow/user/{userId}`
  (`user.deleteUser`) removes a registered presence user (`200`), departs a user who joined by
  `POST /wow/user` (`200`, D13), answers `404` for an unknown or removed user, and `400` for the hosted local
  identity. `tools/verify-wowapi-smoke.mjs` drives every method (`npm run smoke:wowapi`).

The `/wow/spatial/*` payloads are the canonical shapes. `GET /wow/spatial/{spatialID}` returns the `Spatial`
descriptor `{id, rootNodeID, geoPose}`, with an integer graph id, and the root node is at
`/wow/spatial/{spatialID}/node/{rootNodeID}`. When the world's configuration gives the graph an extent, the
descriptor also carries `extent` (D9, item 7). Nodes are the canonical `Node`, with children embedded. Two
labeled Lab conveniences sit on top: `?form=node` on the Spatial path returns the root node itself, and
`X-OSL-WoW-Node-Form: flat` (or `?nodeForm=flat`) selects the flat node form, `OSLFlatNode`, whose `children`
are integer ids. The server also resolves four legacy string aliases for a graph id (the world id, the location
id, `default` and `world`); the contract does not list them.

**The canonical `Node`.** `Node.children` is an array of embedded `Node` objects (`items: $ref: Node`, upstream
`API.yaml:484-487`), not an array of integer ids. The Lab keeps `Node` as the standard states it, because the
conformance corpus measures the Lab against it. The flat form is the separate, labeled `OSLFlatNode`.

## 4. Labeled Lab extensions (`x-osl-extension: true`)

The standard does not state these. Each is a separate schema, so the conformance corpus can tell canonical from
extended members and report every extension in use.

| Extension schema | What it carries |
|---|---|
| `ProofBoundary` | The four claim-boundary flags required on every `/wow` response. Strict: four required booleans, `additionalProperties: false`. |
| `PortalDestination` | The demo's target description of a portal, carried as `osl_destination` (D12). |
| `SpatialFabricSubtree` | The contract for a node that draws a signed `.msf` fabric as a subtree. Strict. Divergence D8, §11. |
| `UniversalExtensionDeclaration` | One WebAssembly extension a node carries, in the array `webofworlds_extension.universal_extensions`: `module` (`url`, `integrity`, `binding`), `interface`, `attach`, `requests`, `limits`, an optional `data` and an optional `purposes` (a requested token -> its purpose text; a purpose for a token that `requests` does not name is refused at stage `declaration`). Strict. The member marks an extension node; a `.wasm` suffix is never sniffed. The Lab runs a declaration only from a world served from its own origin, only when the module's SHA-256 matches `integrity`, and grants the attachment-confined tokens it requests; a token that needs consent is granted only when the user allows it in the consent dialog, which shows each purpose as text (`web/wow-extension-consent.mjs`). A refusal or failure keeps a marker labeled with its stage (`web/wow-scene.mjs`, `web/wow-extension-mount.mjs`). A node may also declare extensions through `webofworlds_extension.universal_extension_manifests`, an array of `{ url }` (a relative `url` resolves against the world file URL) naming signed carrier manifests (Universal Manifest v0.6, each extension an `osl:ExtensionFacet`): the Lab fetches each carrier, verifies its Ed25519/JCS signature over the whole manifest and its `issuedAt`/`expiresAt` before it reads a facet or fetches a module, accepts only `attach.kind` `world-node` with an `anchor`, when present, equal to the carrying node's `id`, and keys grants and storage by the carrier `subject`, the verifying key, `module.integrity` and `attach` (stages `manifest-fetch`, `signature`, `validity`, `facet`; `web/wow-extension-manifest-adapter.mjs`). The same-origin rule applies to both ways. |
| `WebOfWorldsExtension.extension_store`, `WebOfWorldsExtension.extension_status_list`, `ExtensionStatusList` | What a place gives the extensions of its world, at world level, each `{ url }` on the world file's own origin (another origin refuses the world's extensions at stage `declaration`). The store holds copies of the modules, each named `sha256-<digest in base64url, no padding>.wasm` after `module.integrity`: the Lab takes a module from the store, after world load fetches the copies in advance up to 8 MiB in all, and so asks no maker when a glance is selected. A copy whose SHA-256 differs from `module.integrity` is refused at `integrity` and never replaced by the maker's; with no copy (HTTP 404) or no store the module comes from its maker's address at selection, and the record says `codeSource` `maker` (`place` otherwise). The withdrawn list (`ExtensionStatusList`: `checkedAt`, `entries` of carrier manifest `@id` and `status` `revoked` or `suspended`) is fetched once at world load: a carrier it names is refused at `status`; any other carrier runs with `revocationStatus` `unchecked`. No issuer's status address is fetched; a carrier's signed `statusRef` stays a declaration check. The place compiles the list, so it could leave a withdrawn carrier out (`web/wow-extension-place-store.mjs`). |
| `Zone`, `PortalTraversal` | The Lab's portal interaction volumes and traversal-direction rules. |
| `WebOfWorldsExtension` | An open (`additionalProperties: true`) labeled bag on the read surface (`spatial_fabric_address`, `zones`, `geopose_mapping`, …). |
| `OSLFlatNode` | The flat node form: `children` are integer ids. Served and accepted only on explicit request (`X-OSL-WoW-Node-Form: flat` or `?nodeForm=flat`). |
| `OpenUserManifest`, `UMSignature` | A signed user manifest and its signature block, carried as `open_user_manifest` on `OSLUserResponse`. |
| `OSLJoinAnswer` | The join answer (D13) plus the Lab's `record` and `proof_boundary`. |
| `OSLPortalPlacement` | The body of `POST /wow/portal` and `PUT /wow/portal/{portalId}` (`x-osl-overlay: placement`), the Lab's portal placement tool. `tools/placement/check-local-only.mjs` checks who may call them. |

The response composites are what the server returns: the canonical schema plus the labeled extensions, composed
with `allOf`. They are `OSLWorldResponse`, `OSLUserResponse`, `OSLViewResponse` and `OSLPortalResponse`, each
with `required: [proof_boundary]`. Responses are validated against these. The canonical schemas stay as the
standard states them, for the conformance comparison.

## 5. Extension policy

1. **Additive only.** A canonical member is never removed or renamed to fit the Lab.
2. **Always labeled.** Every Lab addition carries `x-osl-extension: true` and sits under the `osl-extension`
   tag or in a `webofworlds_extension` bag. Overlay text carries `x-osl-overlay: iteration-N`.
3. **Reported.** The conformance corpus reports every extension in use. No extension is presented as canonical.
4. **No claimed conformance.** `standards_conformance` is `false` on every `/wow` response. The server sets the
   `proof_boundary` values, and the contract enforces that the flags are present and typed.

## 6. `WS /events`: the event stream, listed under `World.services.events`

The event stream (`user_joined`, `user_left`, `node_created`, `node_updated`, `node_deleted`, and
`portal_activate` from iteration 4) follows the rule in the Events paragraph of `schema.yaml`, which is the
rule the iteration 3 overlay offers. A world that offers an event stream MUST list it in the World resource
under `services.events`, relative to the world's base URL. Each event MUST carry `type`, `revision`, `time`
and `urls`, as the `Event` schema lists them. The Lab's worlds serve the stream at `events`, so `WS /events`.
The first message on a stream is a `hello` whose `convention` names the stream as listed under
`World.services.events` (`runtime/world-server/test/ws-events-presence-proof.js`, check WS1). The WebSocket
upgrade is not an HTTP operation, so it has no entry under `paths`; the World resource names it. The
`simpleWorlds` reference implementation registers `WS /events` before its validator, so its socket messages
are not validated.

## 7. Validation

The server in `runtime/world-server` is plain Node (`http.createServer` and its own router). Validation is a
layer inside it, `runtime/world-server/src/wow-contract-enforcer.js`, which the handlers call. It is always
on: no environment variable or flag turns it off, and `OSL_WOW_VALIDATE` is not read.

- The enforcer builds its table at startup from the `paths` of `wow-spec/generated/schema.json`: for each
  operation, the request schema and the response schema per status. If the contract cannot be loaded, or
  declares no `/wow` operation, the server does not start.
- **Responses.** The enforcer adds `X-OSL-WoW-Validation: pass:<schema>` or `fail:<schema>` (or `error`). It
  never changes the JSON body or the status.
- **Requests.** A write with an invalid body is refused with the contract's 400 or 422. A request body is
  measured without its `readOnly` members in the `required` lists, so a create without `Node.id` is accepted
  while a response without `Node.id` fails (`npm run arch-i1-proof`, check U4).
- `runtime/world-server/test/contract-enforcement-proof.js` (`npm run proof:contract`) proves that enforcement
  stays on and follows the contract.

The validator can also be used directly:

```js
const { getValidator } = require('../wow-spec/validate'); // or wow-spec/index
const v = getValidator();
v.validateResponse('world', payload);     // -> { valid, schema, errors, errorsText }
v.validateCanonical('world', payload);    // against the canonical schema
v.validateRequest('Node', body);          // request-body validation (also 'Node[]')
```

## 8. Types

The server builds its Web of Worlds resources in `runtime/world-server/src/runtime-*-projection.js`
(`runtime-world-projection.js`, `runtime-user-projection.js`, `runtime-view-projection.js`,
`runtime-portal-projection.js` and others). The client reads them in `web/live-adapter.js` and the
`web/live-adapter-world-*.mjs` modules. Both are validated against the same `generated/schema.json` (§7 and
the overlay proofs), not through shared TypeScript types.

`Node` and `OSLFlatNode` are not interchangeable. A node the Lab serves is a `Node`, with children embedded.
`OSLFlatNode` is the flat form, served only on explicit request.

---

## 9. Overlays and declared divergences

Each item below is a place where the Lab does not match the OpenSpatialWorld API at `WoWAPI@d39a1a0`.
`schema.yaml` marks divergences with `x-osl-divergence` and overlay text with `x-osl-overlay`. The conformance evidence of
`node tools/wow-conformance/run.js` (`diagnostics/wow-conformance.json`) lists D1 to D9 under
`declared_divergences`. D10 to D14 are declared in this file and in the overlay READMEs.
`standards_conformance` stays `false`.

| ID | Subject | The standard says | The Lab does | Status |
|---|---|---|---|---|
| **D1** | `Node.children` (`API.yaml:484-487`) | embedded child `Node` objects | embeds child `Node` objects. The flat form (`OSLFlatNode`) is served and accepted only on explicit request | **RETIRED** in iteration 1. The flat form and its request header are the Lab's, labeled. |
| **D2** | `Spatial` schema (`API.yaml:438-468`) | a graph descriptor `{id, rootNodeID, geoPose}` | serves the descriptor by default, with integer ids | **RETIRED** in iteration 1. `?form=node` returns the root node, a Lab convenience. |
| **D3** | `GET /wow/spatial/{spatialID}` (`API.yaml:133-153`) | returns a `Spatial` descriptor | returns the `Spatial` descriptor; the root node stays at `/node/{rootNodeID}` | **RETIRED** in iteration 1. |
| **D4** | `spatialID` path parameter (`API.yaml:141-146`) | `integer` | `integer` | **RETIRED** in iteration 1. Four legacy string aliases still resolve; the contract does not list them. |
| **D5** | node-path parameters (`API.yaml:163-253`) | omits `spatialID` on all four node operations; DELETE spells it `nodeid` | declares `spatialID` on all four; spells `nodeId` | **LABELED REPAIR** of an upstream defect (OpenAPI requires every template variable to be declared). Also offered by iteration 1 (check U1). |
| **D6** | `GET /` (`API.yaml:17-29`) | returns `text/html` | not in the Lab's contract | **OMITTED.** The Lab serves its client another way. |
| **D7** | write of a conformant node body (`API.yaml:163-253`) | a `Node` body with embedded children is stored | stores it, and the response lists the nodes created | **RETIRED** in iteration 1. The 400 and 422 refusal codes (`payload_too_large`, `invalid_parent`, `child_restructure_not_supported` and others) are Lab extensions. |
| **D8** | a node that draws a signed `.msf` fabric as a subtree | a `.msf` URL in `spatialAssetURI` is permitted (a bare `string`); the standard has no signed-document type | `spatialAssetURI` is the address; `webofworlds_extension.spatial_fabric_subtree` (`SpatialFabricSubtree`) is the contract | **DECLARED EXTENSION.** §11. |
| **D9** | iteration 1: frames, GeoPose, matrices, the tree, ids, vocabulary, extent | see D9 below | see D9 below | **DECLARED OVERLAY.** `npm run arch-i1-proof`. |
| **D10** | iteration 2: one world includes another | see D10 below | see D10 below | **DECLARED OVERLAY.** `npm run arch-i2-proof`. |
| **D11** | iteration 3: live state and the event stream | see D11 below | see D11 below | **DECLARED OVERLAY.** `npm run arch-i3-proof`. |
| **D12** | iteration 4: portals, previews and portal events | see D12 below | see D12 below | **DECLARED OVERLAY.** `npm run arch-i4-proof`. |
| **D13** | iteration 5: joining, following and departing | see D13 below | see D13 below | **DECLARED OVERLAY.** `npm run arch-i5-proof`. |
| **D14** | two demo paths that send identity outside the join | see D14 below | see D14 below | **DECLARED.** |

`npm run arch-overlays-proof` checks the overlay text of all five iterations: each patch applies to the upstream
copies after the iterations before it, on both GeoPose forms; the offered text equals the served contract; and
the conformance vocabulary holds (iteration 1 U1 to U5, E1 and the X1 text; iteration 2 O1 to O4; iteration 3
W1 to W3; iteration 4 W1 to W3; iteration 5 W1 to W4).

**Conformance vocabulary, every iteration.** Each overlay's World API text, the served contract, and every
overlay README that uses key words carry the BCP 14 paragraph (RFC 2119, RFC 8174) once. MUST, SHOULD, MAY and
the other key words are requirements only in capitals. Each normative sentence an overlay adds uses one. The
helper is `tools/arch-i1/conformance-words.js`. The checks are U3 (iteration 1), O3 (iteration 2) and W3
(iterations 3, 4 and 5).

**Neutral wording, every iteration.** No added line of any overlay names an outside standard body, product,
person, the Lab or an `x-osl` label (iteration 5 check W4, over iterations 1 to 5 and both forms).

### D1 to D4 and D7: retired in iteration 1

Before iteration 1 the Lab served a flat graph: `children` were integer ids, `GET /wow/spatial/{id}` returned the
root node, graph ids were strings, and a node body with embedded children was refused. The Lab now serves the
canonical shapes by default and stores a node body with embedded children. The ids stay in the register so that
an older reference still resolves.

Two Lab items remain: the flat node form on explicit request, and the refusal codes that say why a body is not
stored. No body is stored with part of it dropped. A body the Lab cannot store whole is refused with a code that
says why (`runtime/world-server/test/spatial-graph-proof.js` section G; `npm run arch-i1-proof` checks N1 to N6).

### D8: `SpatialFabricSubtree`

The address is the standard's and the contract is the Lab's. §11 has the full statement.

### D9: the iteration 1 overlay

Proposed upstream edits in `wow-spec/overlays/iteration-1/`, proven by `npm run arch-i1-proof`:

1. **One frame.** Meters, right-handed, +Y up. A graph's GeoPose anchors its origin on the WGS-84 ellipsoid; at
   zero angles +X is east, +Y up and +Z south. Every position inside a graph is local to its parent. Geodesy
   converts between the two (EPSG method 9837). Checks F1, F3b, F5, G1, G2.
2. **`lon`, not `lan`.** One GeoPose definition (OGC GeoPose 1.0 Basic-YPR). A writer MUST send `lon`. A reader
   MUST also accept `lan`, as deprecated, and MUST refuse a position whose `lon` and `lan` differ. A server MUST
   NOT emit `lan`, and no GeoPose position on the wire carries it. Checks F4, F4s, E1.
3. **One meaning for a matrix.** `localTransform` is a column-major 4x4 that decomposes into translation,
   rotation and scale (glTF 2.0 section 3.5.3), so it has no shear; zero scale is allowed. A matrix that is not
   16 numbers, has a last row other than 0,0,0,1, or has shear is refused (422). Checks T1, T2.
4. **A true tree.** `children` is derived from the tree, and a PUT that changes it is refused (422). A node moves
   by a PUT of `parent`. A node has one parent. Checks N1, N2, N4, N5.
5. **Ids are never reused** within a world: not after a delete, a reset or a restart. Check N3.
6. **Integer graph ids.** `Spatial.id` and `Spatial.rootNodeID` MUST be integers, and the node path declares
   `spatialID` and `nodeId` on all four operations (D5). Checks N6, U1, E1.
7. **Extent.** `Spatial.extent` `{min, max}` is the box the graph occupies, in meters, in the graph's frame. On
   every axis, `min` MUST NOT exceed `max`, and a reader MUST treat an extent whose `min` exceeds `max` as absent.
   A Lab world meets the first rule at startup: a configured extent whose `min` exceeds `max` is refused (422,
   `SPATIAL_EXTENT_MIN_EXCEEDS_MAX`) and the server does not start. The Lab's reader
   (`web/live-adapter-world-reader.mjs`, `readSpatialExtent`) applies the second. Check X1.
8. **Two GeoPose forms.** The overlay comes in two forms: with the two rotation sentences (the axes at zero
   angles, and the rotation order) and without them (`without-rotation-sentences/`). The forms differ only in
   those sentences, both apply to the upstream copies, and both pass U1 and U3. The served contract is the form
   with the sentences. Check U5.
9. **Required lists.** `GeoPose [position, angles]`, `Spatial [id, rootNodeID]`, `User [id]`, `View [id]`,
   `Portal [id]`, `Node [id]`. `World` and `Asset` have no required member. `Node.id` is `readOnly`, and request
   bodies are measured without it (§7). Checks U2 (offered = served), U3, U4.

U1 checks that the patches apply to the upstream copies and fix the path-parameter declarations. U2 checks that
the offered text and the served contract say the same thing. H1 checks that a planted fault whose edit no longer
applies is reported as a harness error.

The rotation sense and order of GeoPose angles (positive yaw turns east toward north; yaw, then pitch, then roll)
are the Lab's assumption. They live in one place, `ROTATION_CONVENTION` in `web/wow-geopose.js`. The form without
the rotation sentences leaves both out of the offered text.

### D10: the iteration 2 overlay: one world includes another

Proposed upstream edits in `wow-spec/overlays/iteration-2/`, proven by `npm run arch-i2-proof`:

1. **The content link.** `Node.spatialAssetURI` MAY name a model, or the `Spatial`, `Node` or `wow/world`
   resource of any world, which is then shown at that node. The client tells them apart by the media type of the
   answer, never by the address (I1). The including node stands in for the included node's parent (I2). Included
   nodes keep their URLs in their own world (I3). The client is `web/wow-inclusion.mjs`, and the `?wow=` player
   mounts its result (`web/wow-inclusion-mount.mjs`).
2. **Verification of an included part.** A host MUST read an included part from the part's own world, at its
   URL, and MUST revalidate it by its entity tag. A copy of that part relayed or embedded by another world MUST
   NOT be shown as that part (I13, in the client and in the `?wow=` player). When the part's own world does not
   answer, the host SHOULD show the placeholder: the player draws one at the embedding node, labelled with the
   reason (I14). A relayed part whose URL answers with a model is loaded as that model (I15).
3. **`World.spatials`.** The ids of a world's graphs, the default graph first. A whole world shows its default
   graph and its other anchored graphs where their GeoPoses put them; a graph with no anchor is not shown; node
   ids are unique across a world's graphs (I9, I10). A reader MUST treat an absent `spatials` as an empty list
   (O3).
4. **`application/wow+json`**, a provisional name, on every resource response; `application/json` stays
   available by negotiation (I1, O2).
5. **Entity tags.** ETag and Last-Modified on the World, the Spatial and the node; 304 on a matching
   `If-None-Match`, with the ETag; 412 on a stale `If-Match`, and 404 first for a node that does not exist; no
   ETag on a successful PUT, because the stored node is not the body as sent (I4, I4b).
6. **Cross-origin access** as the world's policy allows (`cors_allowed_origins`), with ETag exposed and a
   preflight that allows GET, HEAD, POST, PUT and DELETE and the request headers Authorization, Content-Type,
   If-None-Match and If-Match (I11, a browser check).
7. **Scope.** The World README after iteration 2 carries one scope paragraph: the API does not define rendering,
   physics simulation, spatial audio or input-device mapping (O4).

The host's rules are client behaviour: a nesting limit of 3, a budget of 16 graphs handed out in tree order,
cycles found by URL, a placeholder naming each failure, and the included world's environment kept out of the
host (I5 to I8b, I12). A world may sit at a path prefix (`base_path`). A world's read policy (`read_policy`) may
refuse a node with 403, a labeled Lab extension.

O1 checks that the patches apply on both forms (iteration 2's World patch has a per-form variant), O2 that the
offered text equals the served contract, O3 the vocabulary, and O4 the scope paragraph.

### D11: the iteration 3 overlay: live state, observed without users

Proposed upstream edits in `wow-spec/overlays/iteration-3/`, proven by `npm run arch-i3-proof`:

1. **The event stream** (§6), listed as `World.services.events`. Each event carries `type`, `revision`, `time`
   and `urls`; the `Event` schema requires these four. `World.revision` is the current revision and survives
   restarts (O1, O4b). `since=<revision>` replays; past what the world keeps, the world sends `resync` and the
   client re-reads (O4, O4b). Like the `simpleWorlds` reference implementation, events carry `user` on
   `user_joined`, `userId` on `user_left`, the whole `node` on `node_created` and `node_updated`, and `nodeId`
   on `node_deleted`. The Lab's events also carry `ts`. W2 checks on the wire that every event carries what the
   served `Event` schema requires.
2. **No-op writes** create no revision and no event, so mirroring worlds settle (O6b).
3. **Observing creates no user.** Reading, conditional reading and subscribing MUST NOT create a user.
   `users.active_user_count` counts live presence entries and users joined by the identity handshake
   (`POST /wow/user`, D13), and no observers (O2, O2b).
4. **Stream authentication.** A world MAY require authorization for its stream. The token is then the stream's
   first message, the JSON text `{"type": "auth", "token": "<access token>"}`, and never part of a URL. The world
   closes a stream without a valid token within 5 seconds, and refuses a stream from an origin its policy does not
   allow (`event_auth`, O11).
5. **`Node.properties`**, typed by the JSON-LD context served at `/wow/context.jsonld`
   (`wow-spec/context/wow.context.jsonld`). The `wow:` terms are a provisional proposal; `osl:mirror` is a
   labeled Lab extension. A data-point pointer does not pass through `children`.

Lab additions around them: a server-side simulator (`startSimulator`, or `simulator` in the config); mirroring by
observation (`properties.mirror`, `runtime/world-server/src/mirrors.js`, O6); the observer library
(`web/wow-observe.mjs`); live inclusion with a stream budget of 8 (`observeComposition`, O7, O9); the environment
of an included world typed through the context (O10); and the data-point dashboard (`web/wow-dashboard.html`,
O8, a browser check). O3 checks iteration 2 under live state, and O5 a deleted node.

W1 checks that the patches apply after iterations 1 and 2. W2 checks that the offered text equals the served
contract (revision, services, properties, the `Event` schema, the paragraphs and the required lists) and the
events on the wire. W3 checks the vocabulary, and that neither the served contract nor §6 of this file calls the
events path non-canonical.

### D12: the iteration 4 overlay: portals, previews and portal events

Proposed upstream edits in `wow-spec/overlays/iteration-4/`, proven by `npm run arch-i4-proof`:

1. **`Portal.destination`**, the entry URL of the world the portal leads to. Its fragment MAY name where a
   visitor arrives (`#join=node.{id}`). Crossing MUST work as plain navigation to the destination. A client MUST
   first check that the destination answers and, if it does not, MUST refuse with the reason and stay. A portal
   without a destination leads nowhere, and a client MUST NOT cross through it (P1, P2, P8). Seamless crossing,
   with state carried across, is an OPTIONAL profile; its proof is reported apart.
2. **`node` on Portal, User and View**, the node that places it, relative to the base URL. A `geoPose` given with
   it is derived from that node's placement through the graph's anchor and MUST equal it (P7). The hosted user and
   the player view each have a node of graph 1, after the portals; a presence user gets one when it joins and
   loses it when it leaves.
3. **`World.preview`**: an arrival node, a radius and a preview URL (`{base}wow/preview` in the Lab), or an image
   URL, or both. The served schema gives these as `anyOf` alternatives, `[node, radius_m, url]` or `[image]`. The
   preview holds only this world's nodes within the radius, filtered by the read policy. A portal MUST show its
   destination only as far as the destination's preview allows, and a portal inside a preview MUST show closed.
   Reading a preview MUST NOT create a user (P3 to P6). W2 checks a node preview, an image-only preview and a
   preview with both forms against the served `World.preview`.
4. **Portal events.** When a visitor uses a portal, a world that offers an event stream MUST send
   `portal_activate` on it, once for each crossing and before the visitor navigates. The event MUST carry
   `portalId` and `userId`, besides `type`, `revision`, `time` and `urls`, as the `PortalActivate` schema lists
   them; its `urls` name `wow/world`. The Lab sends it when a crossing intent arrives
   (`POST /portal/exit-intent`), before that user's `user_left` (P10, W2).

The demo's own target description of a portal is the labeled `osl_destination` (`PortalDestination`); the demo
client reads it there, and falls back to an older backend's `destination` object. Lab additions around them:
portals added on a node (`addPortal`, and `POST /wow/portal` for the placement tool), the preview declaration
(`setPreview`, or `preview` in the config), the portal client (`web/wow-portal.mjs`) and its rendering in the
`?wow=` player (`web/wow-portal-mount.mjs`, R1, a browser check).

W1 checks that the patch applies after iterations 1 to 3. W2 checks that the offered text equals the served
contract and the portal, user, view, preview and `portal_activate` on the wire. W3 checks the vocabulary.

### D13: the iteration 5 overlay: joining, following and departing

Proposed upstream edits in `wow-spec/overlays/iteration-5/` (one patch serves both GeoPose forms), proven by
`npm run arch-i5-proof`.

**Opt-in.** A Lab world takes part in iteration 5 only when its configuration declares a handshake (`handshake`
in the world config). Such a world states `World.identity`, `World.claims` and `World.issues` and answers
`POST /wow/user`. A world without that configuration states none of them and answers `POST /wow/user` with 404
(`no_handshake_declared`). The schemas keep these members optional: `World` and `World.identity` have no required
member. The conformance corpus reports the iteration 5 checks as N/A on a world that states no identity (§12).
The overlay's Joining paragraph and `schema.yaml` say the same: joining is OPTIONAL for a world, a world that
states `identity` MUST also state `claims` and `issues`, and a world that states no identity takes no joins, so
the joining rules do not apply to it. W3 checks this sentence in the offered text and in `schema.yaml`.

1. **`World.identity`**, the base URL the world stands behind, from its own configuration. Before it discloses
   anything, the visitor's agent MUST check it against the base URL it is about to post to, and the Lab's agent
   sends nothing when they differ (ID6).
2. **`World.claims`**, the claims the world asks for at entry, each required or optional, with optional
   `issuers`. An agent MUST send only these. A claim counts as issuer-verified only when an issuer the world lists
   signed it; otherwise it stays self-asserted (ID2, ID5, ID6). The claim names are provisional.
3. **`World.issues`**, the credential types the world issues. It MAY be empty, and it is empty in the Lab (ID6).
4. **The join, `POST /wow/user`.** The body (`UserJoin`, required `[manifest, proof]`) carries a signed manifest
   holding only the asked claims and a holder proof made for this world and this visit. The answer (`JoinAnswer`,
   required `[outcome, satisfied, not_satisfied]`) states the outcome (proceed, proceed-in-part or deny) and the
   claims satisfied and not satisfied. A required claim not satisfied gives deny. The world records every outcome,
   and the answer grants no permission. Claim values MUST NOT appear in a URL, and the pointer, the signatures,
   the holder proof and its nonce are not reused for another world. Status: 201 for proceed and proceed-in-part,
   403 for deny, 400 for a body that is not a join (ID1, ID4, ID5, ID7). A proceeding join makes a User, which
   `GET /wow/user/{id}` reads, and sends one `user_joined` on the event stream; a deny sends none (W2).
5. **Following.** A page opened at a world's URL with `#follow` joins that world as a new or existing user. The
   verb is matched without regard to case. Bare `#follow` registers presence, stays at the world's arrival, and
   the page states that it follows the world. With `#follow=user.{id}` (or `user/{id}`) the client places the
   visitor at the node that places that user (`User.node`) and keeps the visitor there while that user moves: it
   reads `GET /wow/user/{id}` every 500 ms (`FOLLOW_WATCH_MS`, `keepFollowing` in `web/wow-portal-mount.mjs`) and
   moves the visitor only when the node has moved. A read creates no user. When that user is gone (404), the
   client ends the follow and leaves the visitor where it stands. Three places follow: the main demo page (SE1),
   the `?wow=` viewer camera (SE5), and the embodied avatar of the `?wow=` viewer at `role=player`, which also
   arrives at `#join=node.{n}` (SE6). A new `#join` or `#follow` fragment replaces the follow (SE5).
6. **Departing.** `DELETE /wow/user/{userId}` of a user who joined by `POST /wow/user` answers 200 and ends the
   visit: afterwards `GET` of that User answers 404. The world sends one `user_left` for that user on the event
   stream and keeps the record of the join outcome (SE2, W2).
7. **User ids and the user count.** A world has one User id allocator, shared by users present by
   `/fabric/presence/register` and users who join by `POST /wow/user`, so no two users share an id (SE3).
   `users.active_user_count` counts the handshake users present, and `active_user_count_source` names both kinds
   (SE4).
8. **The `preferences` claim** (the Lab's own shape; the World API carries claims by reference and names none of
   these). It is an object with optional members: `preferred_height_m` (a positive number of meters), `language`
   (a BCP 47 tag) and the accessibility members `captions`, `reduced_motion`, `seated` and `reduced_flashing`
   (booleans), `text_scale` (a positive number) and `input` (the visitor's preferred input modalities, a list of
   strings). The accessibility members are provisional. At least one known member is present, and the height is
   optional. A member of the wrong shape makes the claim not satisfied ("malformed"); a member the Lab does not
   know is ignored. When a world accepts the claim, its answer and its record carry `osl_preferences_applied`,
   with every member the world received and whether it applied it (`true` or `false`). The Lab world applies
   `preferred_height_m` and reports the others as not applied. The agent (`web/wow-handshake.mjs`,
   `PREFERENCE_MEMBERS`) and the world (`runtime/world-server/src/runtime-handshake.js`) name the same members
   (ID9).
9. **The pilot statement, `User.pilot`.** A join carries `pilot` beside the manifest and the holder proof:
   `human`, `agent` or `hybrid`, the visitor's statement of who is at the controls, not proof of it. The world
   copies it onto the User it makes. A join that states no pilot proceeds as far as its claims allow; the world
   sets `User.pilot` to `unstated`, its record names `pilot: "unstated"`, and the world never supplies `human`,
   `agent` or `hybrid`. A join with any other value (for example `robot`, `Human`, `""`, or `unstated` sent by the
   visitor) is answered deny (403) with the reason "pilot statement malformed", with every asked claim listed as
   not satisfied for that reason, and is recorded. `UserJoin` does not list `pilot` as required and gives it no
   type, so that such joins reach the world and are recorded. The Lab's agent sends a pilot on every join and
   sends nothing when the visitor states none. The `?wow=` player states `agent` when automation drives the
   browser (`navigator.webdriver`) and `human` otherwise. A client shows `hybrid` as an agent and `unstated` as
   "pilot not stated" (`pilotShownAs`, `userLabel` in `web/wow-handshake.mjs`). The player's handshake panel
   (`web/wow-handshake-mount.mjs`) shows the User's name with that label (ID10, W2, W3).
10. **Present users who made no join.** A user present by `/fabric/presence/register` stated no pilot, so
    `GET /wow/user` of that user, by player id or by User id, reads `pilot: "unstated"`
    (`runtime/world-server/src/runtime-user-projection.js`). The main demo labels another user's avatar with the
    User's name and "(pilot not stated)", drawn on the avatar (`web/peer-avatar-presentation.mjs`, ID11).
11. **The `body` and `items` claims** (the Lab's own shapes, the wire form of the body-and-item section of the
    architecture contract; the World API carries claims by reference and names neither). A world that fits visitors
    may ask for `body` (the avatar file's digest `model.digest` and front `model.forward`, `height`, `structure`,
    `bones` with rest pose `t`, `r` and roles, `forearmRadius`, `hands`, `feet`, `volumes`) and `items` (a list, each
    `{ itemId, assetUri, mode, fit }`). The world checks both at the join as untrusted data: every number finite, each
    `r` of length 1 within 0.001, each `parent` before its child, names unique, the fifteen required roles and every
    role a volume names present, grip and forward axes non-zero and not parallel, at most 32 items, nesting inside 10
    levels. A bad body is not satisfied ("malformed: expected ..."). A bad item is refused alone: the answer lists it
    in `items_refused` (`{ itemId, reason }`), the record does too (adding `item`, its place in the list), and the
    other items stay. The User made by the join carries `body` and the accepted `items` as sent, and
    `osl_drawn_height_m`, the height the world sets for drawing the visitor: its `preferred_height_m` when the world
    accepted one, else the world's target height (`handshake.target_height_m`, 1.7 m by default). A client draws
    another visitor from these (`web/peer-avatar-presentation.mjs`, through `web/avatar/runtime/wire.mjs`): it hashes
    the avatar file and refuses details that do not match it ("details do not match the file"), sizes the body to the
    drawn height, and draws the accepted items. A number too large for JSON cannot be signed, so the integrity check
    refuses a join that carries one (CV1, RB4, RB5, RB12, RB11).

V1 is the browser view of a join: in the `?wow=` player the visitor enters world A, crosses to world B, joins B
with its avatar, display name and preferences, and B's page draws the accepted avatar at the preferred height.

Lab additions around them, all labeled: the answer's `record` and `proof_boundary` (`OSLJoinAnswer`); the record
itself at `{base}osl/handshake/record/{id}`, outside the World API; a joined user's preferences on its User as
`osl_preferences`; `osl_preferences_applied`; a joined user's `body`, `items` and `osl_drawn_height_m`, and the
answer's `items_refused`; the handshake config (`runtime/world-server/src/runtime-handshake.js`,
served by `runtime/world-server/src/server.js`); the visitor's agent (`web/wow-handshake.mjs`) and its use in the
`?wow=` player (`web/wow-handshake-mount.mjs`, called from `web/app.js`), which only selects the accepted avatar
variant and preferred height through the page's own setters. The manifest and holder-proof shapes are the Lab's
own proposal, not a conformance claim for any manifest format.

W1 checks that the patch applies after iterations 1 to 4. W2 checks that the offered text equals the served
contract (the joining, following and departing paragraphs, `UserJoin`, `JoinAnswer` and `User.pilot`) and the
joins, events and departure on the wire. W3 checks the vocabulary, and W4 the neutral wording of every overlay.

### D14: two demo paths that send identity outside the join

The `?wow=` player sends identity to a world only through the join (D13). Two older demo paths send identity
too, and every world on them receives the same values:

1. **Presence** (`web/live-adapter-presence-controller.mjs`): register and heartbeat carry `player_id`,
   `client_id`, `avatar_id`, `display_name` and `continuity_id`, and `continuity_id` defaults to `avatar_id`.
2. **The seamless crossing** (`web/live-adapter-crossing-manifest.mjs`): the crossing packet's `avatar_context`
   carries a whole signed manifest, whatever the destination asks for.

### D15: the iteration 6 overlay: permissions (scopes, observers, withdrawal, delegation, hosts, grants on one node)

Proposed upstream edits in `wow-spec/overlays/iteration-6/` (three patches: the World API after iterations 1 to 5,
the Asset API after iteration 1, the User Manifest API as vendored; each serves both GeoPose forms), proven by
`npm run arch-i6-proof`. Decision 5, option 1: OAuth 2.0 bearer tokens, each bound to one world, grant records
each world keeps, and token exchange (RFC 8693) for delegation. Part a is G1 to G3; part b is delegation (G4), hosts
(G5) and grants on one node (G6).

**Opt-in.** A Lab world takes part only when its configuration sets `auth: "required"`; the default is `"off"`, and
then nothing changes: open reads, and writes under the local-only rule (`runtime/world-server/src/local-only.js`).
No launch or deploy file sets it. With `"required"`:

1. **The world's own authorization server** (`runtime/world-server/src/world-auth.js`, settings `auth_server`): a
   grant store (subject, scope, resource `world`, `users` or one node `wow/spatial/{g}/node/{n}`, optional expiry,
   withdrawal, and for delegation `acting_for` and `subject_issuer`), a token endpoint at `{base}oauth/token`
   (client credentials and token exchange, `resource` must be the base URL), short-lived tokens signed with Ed25519
   by the Lab's own signing code (`web/signing`; a JWT access token, `typ` `at+jwt`), protected resource metadata at
   `{origin}/.well-known/oauth-protected-resource{path prefix}` (its `resource` is the base URL) and authorization
   server metadata.
2. **Every route enforces its scope** (`runtime/world-server/src/world-auth-policy.js`): `read` for every GET and HEAD
   (`GET /wow/user/{userId}` needs the read grant that names the User resources), `observe` for `/events` and
   `/runtime-state`, `enter` for `POST /wow/user`, `DELETE /wow/user/{userId}` (own user only) and the presence and
   crossing routes, `write` for everything else. `GET /healthz`, preflights and the metadata stay open. A write needs
   both the `write` grant and the local-only conditions.
3. **Errors in `WWW-Authenticate`**: 401 `Bearer` with no error code for no token; 401 `invalid_token` for a token
   that does not verify, is expired or names another audience (compared exactly, so `/w/b` and `/w/bb` refuse each
   other's tokens); 403 `insufficient_scope` with the scope needed. No `resource_metadata` in the 401. A token in a
   URL is refused (400 `invalid_request`).
4. **People only under the presence grant**: `/fabric/presence`, `/debug/state`, `/fabric/region`, the World's
   list of people, the `/events` hello and user events (kept, with their revision, without ids) and `/runtime-state`.
5. **Streams**: the token is the first message; a stream without the `observe` grant is closed (1008) before
   anything is sent; a withdrawn grant or an expired token closes it within 5 seconds.
6. **The join answer names the scopes granted** (`scope`), equal to the world's grant records for the visitor.
7. **Grants on one node**: a node write (POST, PUT, DELETE of `/wow/spatial/{g}/node/{n}`) needs a write grant on
   that node or on the world; a write grant on one node covers no other node. Observe and enter grants name the
   world only; only read names `users`.
8. **Token exchange (RFC 8693)**: `subject_token` (this world's, or from an issuer in `auth_server.trusted_issuers`,
   `{ issuer, public_key }`, whose audience is the base URL or the actor) and `actor_token` (this world's token for
   the actor, by client credentials). Issued only when a grant record with `acting_for` lets the actor act for the
   party acted for (the subject, or the subject token's current actor); the token keeps `sub` (and `sub_iss` for
   another issuer's subject) and carries `act`, the current actor outermost. A request with it is decided on the
   current actor's record, and every decision on a verified token is logged with the subject and the whole chain
   (`decisions()`). A record for acting covers none of the actor's own requests. An untrusted or withdrawn issuer,
   a missing record or a bad token: 400 `invalid_request`. `trust.withdraw(issuer)` stops trusting an issuer.

**What `schema.yaml` serves of it.** The Authorization paragraph (with the token-exchange profile and grants on one
node of part b), `components.securitySchemes` (`worldAuth`, oauth2,
relative token URL), each operation's `security` and its 401 and 403, `JoinAnswer.scope` and the 401 of
`POST /wow/user`. Iteration 5's W2 compares iteration 5's offer against the contract as later iterations leave it: a
`JoinAnswer` member or a `POST /wow/user` status that a later overlay (iteration 6 or above) adds is not counted as a
difference for iteration 5; any other addition still is.

**Which checks run with `"off"`, and why.** Every check that existed before iteration 6: arch-i1 to arch-i5,
arch-a2, the overlay proof's iterations 1 to 5, the conformance corpus, the world-server tests, the x3d route check,
the extension-host check, the trace check and the release check. They prove the open contract of iterations 1 to 5
and the deployed behaviour, and the live deploy does not change; a later release step decides `"required"` for
production. Only the arch-i6 worlds run with `"required"`.

### D16: iteration 7: a running world inside a world (no overlay)

Iteration 7 adds no overlay and no member to `schema.yaml`: what a host and its viewers need of an included live
world is already in iterations 2 to 6. Part a is proven by `npm run arch-i7-proof` (W1 to W4, W6, W7 and the API
inventory); part b adds W5 (precision with a moved render origin), W8 (the window fallback) and a browser check.

1. **The game is ordinary nodes** (`runtime/world-server/src/runtime-game.js`, run only when a world's configuration
   sets `game`): a ball that B's server moves by node writes, a button whose `properties.presses` a visitor raises
   with a node PUT, and a light whose `properties.on` B's server sets from the button. Readers see it through Node
   GETs and `node_updated` events, as any node.
2. **Following**: the host's client reads the included world with the token the viewer holds for it and follows that
   world's `services.events` stream (iteration 3); each event that names a resource it read starts a re-read with
   `If-None-Match`. The ball's position in A is B's state through the including node, within one step.
3. **Acting**: a write goes to the node's URL at its own world, with `If-Match` (iteration 2's 412) and a token that
   world issued by exchange for "host A acts for viewer V" (iteration 6's G5), under a grant record for acting that
   names the one node. Two writes from the same entity tag: one 200, one 412, then a re-read and a retry. A refused
   write (403) changes nothing the client shows and is kept as a refusal.
4. **People**: the host's viewers see an included world's user events with user ids only when that world gives the
   host the presence grant for that viewer (`read` on `users`, acting for V). Without it, every Web of Worlds answer
   and every event names nobody: a node that places a person (the Lab's presence, `webofworlds_extension.role`
   `"user-placement"`) keeps its place, with the label `User`, no User resource and no name that carries the user's
   id. Including creates no user in the included world.
5. **Offline**: when the included world does not answer, the client shows `unreachable` at each including node and
   keeps the world's stream, which reconnects with `since=<last revision>` (iteration 3); the world is read again when
   it answers.
6. **Depth**: a world included inside an included world is shown within the host's nesting limit (iteration 2); past
   it, the link is refused with `nesting limit`.

The API inventory: every request the included world receives through the host is a GET of the World, a Spatial or a
Node, a PUT of a Node, or its event stream; the host asks its authorization server only for client credentials and
the token exchange; the client sends no request header beyond `Accept`, `Authorization`, `If-Match`, `If-None-Match`
and `Content-Type`. Auth stays `"off"` by default: the game and the people rule of item 4 change nothing for a world
that does not set `game` or `auth: "required"`.

## 10. Provenance

- No `simpleWorlds` source code is in this repository.
- The first transcription of `Node` came from `simpleWorlds`' copy of the spec, which types `children` as
  `integer`. The open spec at `d39a1a0` types it `$ref: Node` (`wow-spec/upstream/wowapi-d39a1a0/`), and `Node`
  now follows the open spec.
- The Lab's `operationId`s (`world.getWorld`, `user.getUser`, `user.deleteUser`, `view.getView`,
  `portal.getPortal`) match `simpleWorlds`' names, where upstream uses `getWorldStatus`, `getUserById`,
  `deleteUserById`, `getViewById` and `getPortalById`. The names are kept and disclosed; no code is shared.
- The node path `/wow/spatial/{spatialID}/node/{nodeId}` comes from the open spec. The Lab does not follow
  `simpleWorlds`' `/wow/scene/node`.
- `simpleWorlds` ships an Apache-2.0 `LICENSE` file while its `package.json` says `"license": "UNLICENSED"`.
  Because that is unresolved, the Lab copies nothing from `simpleWorlds` and takes the open spec as its single
  source. `schema.yaml` carries the same statement.

---

## 11. `SpatialFabricSubtree`: a node that draws a signed `.msf` fabric (D8)

### Transclusion is not traversal

| | relation | HTML analogue | mechanism |
|---|---|---|---|
| `spatial_fabric_subtree` on a `Node` | transclusion: the fabric is drawn here, in this node's frame. Nobody travels to it. | `<img src>` | `SpatialFabricSubtree` |
| `destination` on a `Portal` | traversal: the visitor crosses, and the world changes. | `<a href>` | `Portal.destination` (D12) |

The two are kept apart. The extension sits on `Node`, never on `Portal`. The Lab's crossing code (exit intent,
arrival, `handoff_id`) serves traversal only.

### The address is the standard's; the contract is the Lab's

A `.msf` URL in `spatialAssetURI` is valid today: the canonical `Node` types it as a bare `string`. The Lab uses
that address and adds no parallel address field. The address cannot carry what a subtree needs and a leaf does
not, so that goes in the labeled, strict (`additionalProperties: false`) `SpatialFabricSubtree`, at
`node.webofworlds_extension.spatial_fabric_subtree`. The client rules below are in `web/wow-scene.mjs`.

### Three required members, none with a default

- **`unitsPerMeter`.** A celestial fabric is composed in astronomical units. A default would put 1 AU at 1 meter
  in a room-scale world, so an absent value is refused.
- **`upAxis`.** The fabric corpus is Z-up and the Web of Worlds frame is Y-up. A wrong guess turns the fabric on
  its side, so an absent or unknown value is refused, never read as `"z"`.
- **`placement`.** It selects the backend, and the two backends make different claims:

| value | drawn by | depth-correct against avatars? | parity claim |
|---|---|---|---|
| `in-room` | the three.js lowering | yes: one scene graph, one depth buffer | none. `render: "three-approx"`, approximate shading |
| `backdrop` | the Filament stacked layer | no: no shared depth buffer, so nothing can occlude it | the measured-parity path |

Two stacked WebGL canvases cannot share a depth buffer, so the split follows from the rendering, and the schema
records it.

### Refused, never dropped

`requireVerified` is true when absent. A fabric that is unverified, cannot be fetched or has been tampered with is
refused: the client shows an error and keeps a warn-tinted `wow-fabric-refused:<label>` placeholder. It is never
drawn and never dropped without a trace. A subtree whose declared contract is broken is refused when it is found,
before any fetch. "Verified" means a valid signature that chains to a test anchor shipped with the Lab, not an
operating-system or public-PKI trust claim.

### The extension marks a fabric node, never the suffix

A node is a fabric node only when it carries `spatial_fabric_subtree`. The client does not look at the `.msf`
suffix. A node that addresses an `.msf` with no declared contract is not a fabric node: it keeps its usual
behaviour and raises a visible "unspecified subtree contract" warning.

### Not claimed

- `application/msf+jws` is a provisional, unregistered label. No such IANA media type exists.
- The fabric's internal nodes are not projected into the Web of Worlds graph as addressable nodes. They are made
  at an epoch and change with time, so any projection would be a snapshot, not a graph.
- `standards_conformance` stays `false`.

## 12. The conformance corpus

`tools/wow-conformance/` measures a Web of Worlds server against the served contract.

**Against a world it starts.** `node tools/wow-conformance/run.js` (`npm run conformance`) runs the fixture pass
and starts a Lab world on an isolated port (18991 by default; it refuses the demo ports) for the endpoint pass.
It writes `diagnostics/wow-conformance.json`. A narrower run never overwrites the evidence of a richer one (exit
4). It reports each endpoint as conformant, valid but declared divergent (§9), or contract-only.

**Against any world.** `node tools/wow-conformance/run.js --base <url>` runs against a world that is already
running at that base URL. For a world at a path prefix, the URL ends with the prefix. It starts nothing. It runs
the fixture pass, the endpoint pass and the wire suite (`tools/wow-conformance/wire-checks.js`), which holds the
wire halves of the overlay checks: i1:U3, i2:O2, i3:W2, i4:W2, i4:P10, i5:W2 and i5:SE2. It reads only, except
with these flags:

- `--writes`: node writes (a create, two PUTs, and DELETEs of what it made). Use it only on a world that is yours.
- `--lab-crossing`: crossings driven through a Lab world's own `/fabric/presence/register` and
  `/portal/exit-intent`. It needs `--writes`.
- `--out <file>`: writes the run's evidence to that file. A `--base` run never writes
  `diagnostics/wow-conformance.json`.

A join (`POST /wow/user`) and its DELETE are sent only when the World states `identity.base` and a `claims`
array. The corpus joins with a test wallet and sends only the claims the world asks for.

**Verdicts**, one per wire check:

- **PASS**: every part ran and held.
- **FAIL**: a part did not hold. Only FAIL makes the run fail.
- **PARTIAL**: some parts ran and held, and others were skipped by name.
- **SKIP**: no part ran.
- **N/A**: the check does not apply. On a world that states no `World.identity`, i5:W2 and i5:SE2 are N/A with
  the reason "the World states no identity: iteration 5 joining is opt-in".

**Named skips.** A part that does not run is printed as `skipped (not a pass): <what>: <why>`. A skip is never a
pass. The named skips are:

- node writes without `--writes`;
- crossings without `--lab-crossing` (the activation part of i4:W2 is skipped, and i4:P10 is SKIP);
- the joins, when the World states no `identity.base` and `claims`, or asks for a claim the test wallet does not
  hold; the deny join, when the world requires no claim;
- "before navigation" in i4:P10: the corpus is not a client and does not navigate, so i4:P10 is PARTIAL against
  a Lab world.

Exit: 0 when no check fails, 1 on a FAIL, 2 for bad arguments or a protected port. An unknown argument is refused.

**`npm run proof:corpus`** (`tools/wow-conformance/base-url-proof.js`) proves the corpus. It starts a Lab world at
`/w/b` on port 18993 with the handshake, a preview and placement writes, and runs
`run.js --base <it> --writes --lab-crossing`: every wire check passes except i4:P10, which is PARTIAL with the one
"before navigation" skip, and the Lab's evidence file stays unchanged. It runs the same command against two
planted-fault worlds (a depart that leaves the user present; a crossing that sends no `portal_activate`), and each
must exit 1 and name its check. It starts a Lab world with no handshake and runs `run.js --base <it>`: the run
must exit 0, with i5:W2 and i5:SE2 N/A. A planted fault, a corpus that marks such a world failed, must exit 1 and
name i5:W2.
