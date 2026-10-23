# OSL ↔ WoW Contract (wow-spec)

**Phase-0 GATE ·**

`wow-spec/` is OSL's **typed, validated source of truth** for the
OpenSpatialWorld ("Web of Worlds") API. One YAML (`schema.yaml`) drives both the
shared TypeScript types and runtime request/response validation. **Every
Phase-1 lane reads this note before building.**

This is the single reference for what is **canonical** (the open standard) versus
a **labeled OSL extension** (additive, non-canonical, surfaced by conformance).

---

## 1. Files

| File | Role |
|---|---|
| `wow-spec/schema.yaml` | **Source of truth.** OpenAPI 3.0.4. Canonical schemas + labeled OSL extensions. Human-edited. |
| `wow-spec/generated/schema.json` | Build artifact: `schema.yaml` compiled to JSON (what the ajv layer loads). |
| `wow-spec/generated/wow-types.d.ts` | Build artifact: shared TypeScript types (openapi-typescript). |
| `wow-spec/types.d.ts` | Ergonomic named re-exports (`World`, `Node`, `OSLWorldResponse`, …) for server + client. |
| `wow-spec/validate.js` | The **ajv validation layer** (the additive mechanism). |
| `wow-spec/index.js` | Public entry: `apiSpecPath`, `schemaJsonPath`, `createValidator`, `getValidator`. |
| `wow-spec/proof/roundtrip.js` | The acceptance proof (22 checks). |

## 2. Build & prove (commands)

```bash
npm run wow-schema-json   # schema.yaml -> generated/schema.json  (js-yaml, build-time)
npm run wow-types         # schema.yaml -> generated/wow-types.d.ts (openapi-typescript)
npm run wow-build         # both of the above
npm run wow-proof         # start 041 on an ISOLATED port, prove good passes / bad rejected
```

Regenerate `generated/*` whenever `schema.yaml` changes and re-run `wow-proof`.

## 3. Canonical surface (transcribed from the open OpenSpatialWorld spec)

Pinned to upstream **`WoWAPI@d39a1a0`** ("fixed node children type", 2026-05-21).

- **Schemas:** `GeoPose`, `World`, `User`, `View`, `Portal`, `Node`, `Spatial`.
  (`GeoPose` is factored for DRY; the standard inlines the same shape. The iteration 1
  overlay spells longitude `lon`, as OGC GeoPose does, and reads `lan` as deprecated: D9.)
- **Paths:** `GET /wow/world`, `GET|DELETE /wow/user/{userId}`,
  `GET /wow/view/{viewId}`, `GET /wow/portal/{portalId}`, and the **canonical
  Spatial Composition Graph** `GET /wow/spatial/{spatialID}` +
  `GET|POST|PUT|DELETE /wow/spatial/{spatialID}/node/{nodeId}`.
- **Canonical `/wow/spatial` decision (PROP §9):** OSL adopts the spec's own
  canonical node path `/wow/spatial/{spatialID}/node/{nodeId}`. The `simpleWorlds`
  reference impl diverges to `/wow/scene/node/{nodeId}`; **we do NOT follow that
  divergence.** These paths **ARE served** by the 041 backend.
- Canonical schemas set **no `additionalProperties: false`** — matching the
  standard's openness. This is the seam OSL extends.
- **Which contracted METHODS are actually SERVED — observed on the wire, not
  asserted.** All four node ops (`GET|POST|PUT|DELETE
  /wow/spatial/{spatialID}/node/{nodeId}`) **are served**. Node `DELETE` removes
  the node **and its subtree** (`200 {ok:true, deleted:[…], count:N}`) and refuses
  the root with `400 cannot_delete_root`
  (`runtime/world-server/src/server.js`; tested by
  `runtime/world-server/test/spatial-graph-proof.js`
  checks D6/D8). **`DELETE /wow/user/{userId}` is served too** (`operationId:
  user.deleteUser`): it removes a registered presence user (`200`), answers `404` for an unknown
  or already removed user, and `400` for the hosted local identity.
  Every contracted method is served. `tools/verify-wowapi-smoke.mjs` drives them
  all (`npm run smoke:wowapi`).

> **The `/wow/spatial/*` payloads are the canonical shapes by default (iteration 1).**
> `GET /wow/spatial/{spatialID}` returns the **`Spatial`** descriptor `{id, rootNodeID,
> geoPose}`, and the graph id is an **integer**. The root node is at
> `/wow/spatial/{spatialID}/node/{rootNodeID}`. Nodes are the canonical **`Node`**,
> children **embedded**. Two OSL conveniences ride on top, and both are labeled:
> `?form=node` on the Spatial path returns the root node itself, and
> `X-OSL-WoW-Node-Form: flat` (or `?nodeForm=flat`) selects the flat node form,
> **`OSLFlatNode`**, whose `children` are integer ids. The server also still
> resolves four legacy string aliases for a graph id (the world id, the location
> id, `default`, `world`); the contract does not list them. The divergences this
> note once declared here (D1 to D4 and D7) are **retired**. See **§9**. What
> iteration 1 adds that the standard does not state is declared as **D9**.

**Canonical `Node` — read this before you touch it.** `Node.children` is an array
of **EMBEDDED `Node` objects** (`items: $ref: Node`, upstream `API.yaml:484-487`).
It is **NOT** an array of integer id references. Until 2026-07-11 this contract
said `integer` and the conformance harness asserted that inversion *as if it were
the standard* — so the project booked a green self-test for **rejecting the
standard**. Corrected by. Keep `Node` pure: it is the
yardstick the conformance lane measures us against.

## 4. Labeled OSL extensions (additive · non-canonical · `x-osl-extension: true`)

The WoW standard is silent on these. Each is a **separate, annotated** schema, so
the conformance lane can diff canonical-vs-actual and **surface — never
hide — extension usage.**

| Extension schema | Why (WoW is silent) |
|---|---|
| `ProofBoundary` | The four claim-boundary flags **required on every `/wow` response**. Strict (all four required booleans, `additionalProperties:false`). |
| `PortalDestination` | The canonical `Portal` is a bare `{id, geoPose}` with **no destination** — it cannot express "leads to world X". This labeled point carries it. |
| `SpatialFabricSubtree` | WoW can **address** a subtree but cannot **specify** one. A `.msf` URL in `Node.spatialAssetURI` is **spec-legal today** (the canonical `Node` types it as a bare `string` — no `format`, no `mediaType`, no enum, no prose), and the sibling OpenSpatialAsset spec is already media-type-plural — but neither has any concept of a **signed, executable spatial document**, and the address cannot carry what a *subtree* needs and a *leaf* does not: the scale, the up-axis, the trust policy, the recursion cap, the epoch. So `spatialAssetURI` stays **the address** (adopt WoW) and this labeled, **strict** schema is **the contract** (label it). **Divergence D8.** |
| `Zone`, `PortalTraversal` | OSL-native portal interaction volumes and traversal-direction rules. |
| `WebOfWorldsExtension` | The **open** (`additionalProperties:true`) labeled bag the live 041 server already rides on the read surface (`spatial_fabric_address`, `zones`, `geopose_mapping`, …). Non-canonical and evolving. |
| `OSLFlatNode` | **OSL's flat node form**, a labeled extension. The canonical `Node` **embeds** child objects, and OSL serves that by default. Some clients want a node whose `children` are **integer id references**: it is cheap to read without the subtree and cycle-free on the wire. OSL serves and accepts that form only on explicit request (`X-OSL-WoW-Node-Form: flat` or `?nodeForm=flat`). It is the labeled remainder of the retired divergence **D1**. |

**OSL response composites** — what the 041 server *actually* returns — are the
canonical schema **plus** the labeled extensions, composed with `allOf`:
`OSLWorldResponse`, `OSLUserResponse`, `OSLViewResponse`, `OSLPortalResponse`
(each `required: [proof_boundary]`). Response validation checks against **these**;
the pure canonical schemas stay clean for the conformance diff.

## 5. Extension policy (binding)

1. **Additive only.** Never remove or rename a canonical field to fit OSL. Add.
2. **Always labeled.** Every OSL addition carries `x-osl-extension: true` and
   lives under the `osl-extension` tag or a `webofworlds_extension` bag.
3. **Surfaced, never hidden.** Conformance reports extension usage
   explicitly; extensions are never disguised as canonical.
4. **Honesty preserved.** `standards_conformance` stays **`false`** on every
   `/wow` response. No cosmetic conformance. The `proof_boundary` values are
   enforced by the server; this contract enforces the flags' presence/types.

## 6. `WS /events` — LABELED NON-CANONICAL realtime convention

Realtime (user_joined/left, node_created/updated/deleted) is a **non-canonical
convention** documented here, **not** in this HTTP contract. The `simpleWorlds`
reference impl registers `WS /events` before its validator so socket messages are
unvalidated; OSL's realtime lane implements it as a labeled convention.
It is intentionally **out of the OpenAPI HTTP contract**.

## 7. Validation mechanism (ADDITIVE — not an Express migration)

The `runtime/world-server` backend is **dependency-free vanilla
Node** (`http.createServer`, hand-rolled router). Per the reuse-over-rebuild
mandate (PROP §12), validation is an **additive ajv layer the existing handlers
call** — **NOT** `express-openapi-validator` and **NOT** an Express port.

- The four `/wow/*` GET handlers pass their 200-payload through `wowValidate(res, kind, obj)`.
- **Default (`OSL_WOW_VALIDATE` unset): zero behavior change** — the helper
  returns the object unchanged, adds no header, and **loads no third-party
  dependency** (the dependency-free serve path is preserved byte-for-byte).
- **Enabled (`OSL_WOW_VALIDATE=1`):** the response is validated and an
  observability header `X-OSL-WoW-Validation: pass|fail:<schema>` is added. The
  **JSON body and status are never altered** (conformance is *surfaced*, not
  silently "fixed"). extends this to every endpoint + the request side.

Consume the mechanism directly:

```js
const { getValidator } = require('../wow-spec/validate'); // or wow-spec/index
const v = getValidator();
v.validateResponse('world', payload);     // -> { valid, schema, errors, errorsText }
v.validateCanonical('world', payload);    // vs the PURE canonical schema (conformance diff)
v.validateRequest('Node', body);          // request-body validation (also 'Node[]')
```

## 8. Single-source (server + client)

Both sides consume the generated types from `wow-spec/types.d.ts` via JSDoc
(`@typedef {import('.../wow-spec/types').OSLWorldResponse}`) — **no TS
migration.** Server: `runtime/world-server/src/runtime-state.js`
(WoW projections). Client: `web/live-adapter.js` (`worldFromLive` /
`portalEntryFromWowPortal`).

> When you mean *"a node OSL serves"*, the type is **`Node`**, children embedded.
> `OSLFlatNode` is the flat form, served only on explicit request. It is OSL's
> labeled extension and is not the standard. They are not interchangeable.

---

## 9. Known divergences from the standard (DECLARED)

**.** Every item below is a place where OSL does **not** match
the OpenSpatialWorld spec (`WoWAPI@d39a1a0`). They are declared here, annotated
`x-osl-divergence` in `schema.yaml`, and emitted in
`evidence/wow-conformance.json` under `declared_divergences`. **`standards_conformance`
stays `false`.** Publishing this register *is* the point: a divergence we name is a
position; a divergence we hide is a false claim.

| ID | Subject | The standard says | OSL does | Status |
|---|---|---|---|---|
| **D1** | `Node.children` (`API.yaml:484-487`) | **EMBEDDED** child `Node` objects (`items: $ref: Node`) | embeds child `Node` objects, as the standard does. One labeled extension remains: the **flat form** (`OSLFlatNode`, `children` are integer ids) is served and accepted only on explicit request (`X-OSL-WoW-Node-Form: flat` or `?nodeForm=flat`) | **RETIRED** in iteration 1. The flat form is OSL's, labeled, and the standard specifies neither it nor the request header. |
| **D2** | `Spatial` schema (`API.yaml:438-468`) | a graph **descriptor** `{id, rootNodeID, geoPose}` | serves the descriptor **by default**, with integer ids | **RETIRED** in iteration 1. The opt-in it once needed (`?form=descriptor`, `X-OSL-WoW-Spatial-Form`) is gone. `?form=node` returns the root node, an OSL convenience. |
| **D3** | `GET /wow/spatial/{spatialID}` (`API.yaml:133-153`) | returns a **`Spatial`** descriptor (`getSpatialById`) | returns the **`Spatial`** descriptor. The root node stays at `/node/{rootNodeID}` | **RETIRED** in iteration 1. |
| **D4** | `spatialID` path param (`API.yaml:141-146`) | `integer` | `integer` | **RETIRED** in iteration 1. The server still resolves four legacy string aliases (the world id, the location id, `default`, `world`) for compatibility; the contract does not list them. |
| **D5** | node-path params (`API.yaml:163-253`) | **omits** `spatialID` on all four node ops; DELETE misspells it `nodeid` | declares `spatialID` on all four; spells `nodeId` correctly | **LABELED REPAIR** of an upstream defect (OpenAPI requires every template var be declared) — propose upstream. |
| **D6** | `GET /` (`API.yaml:17-29`) | returns `text/html` (provisions the web app) | not in the OSL contract | **OMITTED** — OSL serves its client differently. |
| **D7** | write path for a **conformant** node body (`API.yaml:163-253`) | a `Node` body (embedded children) is simply **stored** | stores it by default, and the response lists the nodes created at the top level | **RETIRED** in iteration 1. The 400 and 422 refusal codes (`payload_too_large`, `invalid_parent`, `child_restructure_not_supported` and others) are **OSL extensions**: the standard specifies none of them. |
| **D8** | a node that **transcludes a signed `.msf` fabric as a SUBTREE** | a `.msf` URL in `spatialAssetURI` is **permitted** (bare `string`), but the standard says nothing about what the URI resolves to and has **no signed-document type** at all (OpenSpatialAsset is media-type-plural but has none) | `spatialAssetURI` = the **ADDRESS** (adopted); `webofworlds_extension.spatial_fabric_subtree` = the **CONTRACT** (`SpatialFabricSubtree`, strict) | **DECLARED EXTENSION**. See **§11**. |
| **D9** | the **iteration 1 overlay** (`API.yaml:294,368,395,424,456` `lan`; `488-491` `localTransform`; `482-487` `parent`, `children`) | spells longitude `lan`; types `localTransform` as an array of numbers of any length; says nothing about whether `children` can be written, how a node moves, or whether a node id can be reused | spells longitude **`lon`** (`lan` is read as deprecated and never emitted); refuses a `localTransform` that is not 16 numbers with a last row of 0,0,0,1, or that has shear or zero scale (**422**); **derives `children`** from the tree (a PUT that changes them is **422**); **moves** a node by a PUT of `parent`; **never reuses** a node id within a world | **DECLARED OVERLAY** — each item is a proposed upstream edit, proven by `npm run arch-i1-proof`. See **D9** below. |

### D1 to D4 and D7 — retired in iteration 1

Until iteration 1 OSL served a flat graph: `children` were integer ids, `GET /wow/spatial/{id}` returned the
root node, graph ids were strings, and a node body with embedded children was refused. Each was a declared
departure from the standard. They are gone. OSL now serves the canonical shapes by default, and a node
body with embedded children is stored. Their ids stay in this register so that an older reference still
resolves.

What remains is one labeled extension, the flat node form on explicit request, and the refusal codes OSL
uses to say why it will not store a body. Both are OSL's, and the standard specifies neither.

A silent truncation was the worst failure here, and it stays fixed: no body is ever stored with part of
it dropped. A body OSL cannot store whole is refused with a code that says why. Proven by section G of
`runtime/world-server/test/spatial-graph-proof.js` and by `npm run arch-i1-proof` (checks N1 to N6).

### D8 — `SpatialFabricSubtree`: the address is WoW's, the contract is ours

See **§11** for the full statement. In one line: **"permitted" is not "specified."**

### D9 — the iteration 1 overlay: five proposed edits, served and proven

OSL serves behaviour that the standard at `d39a1a0` does not state. Each item is a proposed upstream
edit (`wow-spec/overlays/iteration-1/`), and each is proven by `npm run arch-i1-proof` with a negative
case that fails on purpose:

1. **One frame.** Metres, right-handed, +Y up. A graph's GeoPose anchors its origin on the WGS-84
   ellipsoid; at zero angles +X is east, +Y up and +Z south. Every position inside a graph is local
   to its parent. Real geodesy converts between the two (EPSG method 9837); checks F1 to F5.
2. **`lon`, not `lan`.** One GeoPose definition (OGC Basic-YPR). The reader maps `lan` to `lon`
   with a deprecation warning and refuses a `lon` and `lan` that disagree. Check F4.
3. **One meaning for a matrix.** `localTransform` is a column-major 4x4 that decomposes into
   translation, rotation and non-zero scale, with no shear (glTF 2.0 section 3.5.3). Checks T1, T2.
4. **A true tree.** `children` is derived and a PUT never changes it; a node moves by a PUT of
   `parent`; there is one parent per node. Checks N1, N2, N5.
5. **Ids are never reused** within a world, after a delete, a reset or a restart. Check N3.

The rotation sense and order of GeoPose angles (positive yaw turns east toward north; yaw, then
pitch, then roll) are an assumption until the GeoPose working group answers. They live in one place,
`ROTATION_CONVENTION` in `web/wow-geopose.js`.

### D10 — the iteration 2 overlay: one world includes another

Each item is a proposed upstream edit (`wow-spec/overlays/iteration-2/`), proven by
`npm run arch-i2-proof`, where every check has planted faults that must turn it red:

1. **The content link.** `Node.spatialAssetURI` may name a model, or the `Spatial`, `Node` or `wow/world`
   resource of any world, which is then shown at that node (decision 4, 2026-10-22). The client decides by
   the answer's media type, never by the address (check I1). The including node stands in for the
   included node's parent (I2); included nodes keep their URLs at their owner (I3). The client is
   `web/wow-inclusion.mjs`; the `?wow=` player mounts its result (`web/wow-inclusion-mount.mjs`).
2. **`World.spatials`.** The ids of a world's graphs, the default graph first. A whole world shows its
   default graph and its other anchored graphs where their GeoPoses put them; a graph with no anchor is
   not shown; node ids are unique across a world's graphs (I9, I10).
3. **`application/wow+json`**, a provisional working name, on every resource response;
   `application/json` stays available by negotiation (I1, O2).
4. **Entity tags.** ETag and Last-Modified on the World, the Spatial and the node; 304 on
   `If-None-Match`; 412 on a stale `If-Match` (I4, I4b).
5. **Cross-origin reads** as the world's policy allows (`cors_allowed_origins`), with ETag exposed and a
   preflight that allows Authorization, If-None-Match and If-Match (I11, a load-gated browser check).

The host's rules (a nesting limit of 3, a budget of 16 graphs handed out in tree order, cycles found by URL,
a placeholder naming each failure, and the included world's environment kept out of the host) are client
behaviour, checked by I5 to I8b and I12. A world may sit at a path prefix (`base_path`); a world's read
policy (`read_policy`) may refuse a node with 403, a labeled OSL extension.

## 10. Provenance — corrected 2026-07-11

The previous version of this note and of `schema.yaml` claimed the contract was
*"NOT copied from the UNLICENSED simpleWorlds reference implementation"*, and
`evidence/wow-conformance.json` claimed *"No simpleWorlds code vendored."*
**Those sentences were not supportable and are withdrawn.** What is true:

- **No simpleWorlds SOURCE CODE is vendored** in this repository. That part holds.
- **But the first transcription of `Node` came off simpleWorlds' stale spec copy,
  not the open spec.** It typed `children` as `integer`; simpleWorlds
  (`packages/wow-spec/src/schema.yaml:425-428`) types it `integer`; the open spec
  says `$ref: Node`. Upstream `WoWAPI` has **exactly one commit** — *"fixed node
  children type"* — so **no published upstream state has ever said `integer`**.
- **Corroboration:** our `operationId`s match simpleWorlds **5-for-5**
  (`world.getWorld`, `user.getUser`, `user.deleteUser`, `view.getView`,
  `portal.getPortal`) where upstream uses `getWorldStatus`, `getUserById`,
  `deleteUserById`, `getViewById`, `getPortalById`. The naming is **retained**
  (naming only, no code) and is now disclosed rather than implicitly denied.
- **Sourcing was MIXED, not wholesale.** OSL took
  `/wow/spatial/{spatialID}/node/{nodeId}` from the **open spec** and deliberately
  **rejected** simpleWorlds' `/wow/scene/node` divergence (PROP §9). Someone
  clearly had the real spec in view for some decisions and not for others.
- **Licensing.** simpleWorlds' own license state is **self-contradictory**: the
  repo ships an **Apache-2.0 `LICENSE` file** while its `package.json` (root and
  `packages/wow-spec`) declares `"license": "UNLICENSED"`. Because that is
  unresolved, OSL treats simpleWorlds as **DO-NOT-COPY** and single-sources the
  open spec. `Node` is now restored verbatim from the open spec.

---

## 11. `SpatialFabricSubtree` — a WoW node that transcludes a signed `.msf` fabric (D8)

**.** The subtree analogue of the node's glTF **leaf**.

### The one distinction you must not get backwards

**TRANSCLUSION ≠ TRAVERSAL.** They look alike on the wire and they mean opposite things.

| | relation | HTML analogue | mechanism |
|---|---|---|---|
| `spatial_fabric_subtree` on a **`Node`** | **TRANSCLUSION** — the fabric is **drawn HERE**, in this node's own accumulated frame. Artemis's Earth **IS** the child fabric. **Nobody travels to it.** | `<img src>` | this schema |
| `destination` on a **`Portal`** | **TRAVERSAL** — you walk through and **the world changes**. | `<a href>` | `PortalDestination` (D-register) |

They are **deliberately NOT merged.** The extension rides on **`Node`**, **never** on `Portal`.
OSL's entire crossing machinery (exit-intent, arrival, `handoff_id` continuity, the 180° exit
isometry) serves **traversal** and nothing else.

### The address is WoW's; the contract is ours

A `.msf` URL in `spatialAssetURI` **validates today** — the canonical `Node` types it as a bare
`string` with no `format`, no `mediaType`, no enum and no prose. **We adopt that**, and we do **not**
invent a parallel address field. But *permitted* is not *specified*: the address cannot carry what a
**subtree** needs and a **leaf** does not. That goes in the labeled, **strict**
(`additionalProperties: false`) `SpatialFabricSubtree`, carried at
`node.webofworlds_extension.spatial_fabric_subtree`.

### Three required fields, and every one of them has already bitten

- **`unitsPerMeter` — REQUIRED, NO DEFAULT.** The compositor's `auto` rule composes a *celestial*
  fabric in **AU**. Inherited into a 1:1-metre WoW room, `auto` silently means **1 AU = 1 metre**. A
  defensible reading and a catastrophic default. **Refused, not defaulted.**
- **`upAxis` — REQUIRED, NO DEFAULT.** The fabric corpus is **Z-up**; WoW/Three is **Y-up**. Guess
  wrong and **the solar system lies on its side**, silently. An absent or unrecognized value is a
  **refusal**, never a fallback to `"z"` — a fallback would reintroduce the exact bug the field exists
  to kill. *(This is why the field is `required` here even though the originating task's draft stanza left
  it optional: `web/wow-fabric-transform.mjs` **already refuses** an absent `upAxis`. A contract that
  disagrees with its implementation is the disease this lane is treating.)*
- **`placement` — REQUIRED, NO DEFAULT.** It **selects the backend**, and the two backends make
  **different honesty claims**:

| value | drawn by | depth-correct vs avatars? | parity claim |
|---|---|---|---|
| `in-room` | the **Three** lowering | **YES** — one scene graph, one depth buffer | **NONE, EVER.** `render: "three-approx"`. Approximate shading. |
| `backdrop` | the **Filament** stacked layer | **NO** — no shared depth buffer, so nothing can occlude it | faithful/enhanced; the **measured-parity** path |

That split is **forced, not preferred**: two stacked WebGL canvases cannot depth-composite. That is
physics. **The schema is where that truth is recorded.**

### Fail-closed, at every level

`requireVerified` defaults to **TRUE** when absent. A fabric that is unverified, unfetchable or
tampered is **REFUSED** — a visible error and a kept, warn-tinted `wow-fabric-refused:<label>`
placeholder. **Never silently dropped, never drawn.** A subtree whose *declared contract* is broken is
refused at **discovery**, before any fetch. "VERIFIED" means a valid signature chaining to a **shipped
test anchor** — **not** an OS-trust / public-PKI claim.

### The discriminator is the extension, never the suffix

A node is a fabric node **iff** it carries `spatial_fabric_subtree`. The `.msf` **suffix is never
sniffed** — sniffing is fragile and, worse, it **hides the very contract this schema exists to state**.
A node addressing an `.msf` with *no* declared contract is **not** a fabric: it keeps today's behaviour
and raises a visible **"unspecified subtree contract"** warning.

### Not claimed

- `application/msf+jws` is a **PROVISIONAL, UNREGISTERED** label. **No such IANA media type exists.**
- The fabric's internal nodes are **NOT** projected into the WoW graph as addressable WoW nodes. They
  are produced by `map.wasm` **at an epoch** and are time-dependent, so any projection is a **snapshot**,
  not a graph. Deliberately deferred.
- **`standards_conformance` stays `false`.** This is a labeled extension, declared as **D8**, surfaced
  by the conformance lane. **Nothing here earns a flip.**
