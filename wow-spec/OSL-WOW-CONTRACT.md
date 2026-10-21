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
  (`GeoPose` is factored for DRY; the standard inlines the identical shape — the
  `lan` misspelling of *longitude* is carried verbatim.)
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
  checks D6/D8). **`DELETE /wow/user/{userId}` is contracted
  (`operationId: user.deleteUser`) but is NOT served** — the live server answers
  `404`. That single method is the whole of the DELETE gap. Both facts are
  re-derived from a running server on every run of
  `src/wow-claim-drift-proof.mjs`.

> ⚠️ **The `/wow/spatial/*` PATHS are canonical; their PAYLOADS are NOT.**
> OSL serves the labeled `OSLFlatNode`, **not** the canonical `Node`, and **by
> default** it returns the **root node** where the standard returns a **`Spatial`
> descriptor**. `Spatial` is in the contract **and IS SERVED** — on a **versioned
> opt-in** (`?form=descriptor`, or header `X-OSL-WoW-Spatial-Form: descriptor`),
> with the served form echoed back in `X-OSL-WoW-Spatial-Form: descriptor|node`.
> The **default** deliberately stays the root node so no existing client breaks;
> that default is the whole of the remaining divergence. Served by
> ****wire-proven by `src/wow-gaps-proof.mjs`
> (10 checks) and drift-guarded by `src/wow-claim-drift-proof.mjs`.
> **DECLARED:** the opt-in itself — the `form` query
> parameter, the `X-OSL-WoW-Spatial-Form` request header, and the
> `X-OSL-WoW-Spatial-Form` response header — is declared on the
> `GET /wow/spatial/{spatialID}` operation in `schema.yaml`, and the `Spatial`
> schema stanza states it is served on the versioned opt-in. The contract
> declaration and the served behavior are kept in lockstep by
> `src/wow-claim-drift-proof.mjs` (bidirectional: it goes RED if either
> drifts from the other). See **§9**.

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
| `OSLFlatNode` | **The node OSL actually serves.** Here the standard is *not* silent — it says something else, and we disagree with it on purpose. The canonical `Node` **embeds** child objects; OSL serves a **flat graph** whose `children` are **integer id references**, so a node is addressable at `/wow/spatial/{id}/node/{nodeId}` in O(1), updatable without rewriting an enclosing subtree, and cycle-free on the wire. A **declared divergence (D1)**, not a reading of the spec — proposed upstream alongside `PortalDestination`. Every `/wow/spatial/*` request body and response references **this**, never `Node`. |

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

> When you mean *"a node OSL serves"*, the type is **`OSLFlatNode`**.
> `Node` means **the standard**. They are not interchangeable.

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
| **D1** | `Node.children` (`API.yaml:484-487`) | **EMBEDDED** child `Node` objects (`items: $ref: Node`) | **INTEGER id references** (flat graph) | **DECLARED** — served on every `/wow/spatial/*` payload as `OSLFlatNode`. Conformance reports `canonical_node_valid:false`. |
| **D2** | `Spatial` schema (`API.yaml:438-468`) | a graph **descriptor** `{id, rootNodeID, geoPose}` | transcribed **AND SERVED** on a versioned opt-in (`?form=descriptor` / `X-OSL-WoW-Spatial-Form: descriptor`) | **DECLARED** — served on a versioned opt-in. Wire-proven: `src/wow-gaps-proof.mjs` (10 checks, `--negative=spatial` demands RED); drift-guarded: `src/wow-claim-drift-proof.mjs`. **The opt-in — `form` query param + `X-OSL-WoW-Spatial-Form` request/response header — is DECLARED on `GET /wow/spatial/{spatialID}`.** |
| **D3** | `GET /wow/spatial/{spatialID}` (`API.yaml:133-153`) | returns a **`Spatial`** descriptor (`getSpatialById`) | returns **the root node itself BY DEFAULT**; returns the canonical descriptor on the D2 opt-in | **DECLARED** — default node · descriptor on opt-in. The break is versioned, never silent. |
| **D4** | `spatialID` path param (`API.yaml:141-146`) | `integer` | `string` (`world_id`, `location_id`, `default`, `world`) | **DECLARED** — deliberate; 041 addresses graphs by string id. |
| **D5** | node-path params (`API.yaml:163-253`) | **omits** `spatialID` on all four node ops; DELETE misspells it `nodeid` | declares `spatialID` on all four; spells `nodeId` correctly | **LABELED REPAIR** of an upstream defect (OpenAPI requires every template var be declared) — propose upstream. |
| **D6** | `GET /` (`API.yaml:17-29`) | returns `text/html` (provisions the web app) | not in the OSL contract | **OMITTED** — OSL serves its client differently. |
| **D7** | write path for a **conformant** node body (`API.yaml:163-253`) | a `Node` body (embedded children) is simply **stored** | **422 `embedded_children_not_supported`** by default; stored only on the **explicit** `X-OSL-WoW-Node-Form: canonical` opt-in, which **flattens** the subtree into id-refs and reports what it stored | **DECLARED EXTENSION**. The opt-in header, the `?nodeForm=canonical` query form, the `X-OSL-WoW-Nodes-Stored` / `X-OSL-WoW-Children-Flattened` response headers, and the 400/422 refusal codes are **OSL extensions** — the standard specifies none of them. |
| **D8** | a node that **transcludes a signed `.msf` fabric as a SUBTREE** | a `.msf` URL in `spatialAssetURI` is **permitted** (bare `string`), but the standard says nothing about what the URI resolves to and has **no signed-document type** at all (OpenSpatialAsset is media-type-plural but has none) | `spatialAssetURI` = the **ADDRESS** (adopted); `webofworlds_extension.spatial_fabric_subtree` = the **CONTRACT** (`SpatialFabricSubtree`, strict) | **DECLARED EXTENSION**. See **§11**. |

### D7 — why a conformant body is refused by default

Until 2026-07-11, `spatial-graph.js` ran `.filter(Number.isInteger)` over a node's
`children` and `createChildren()` then forced `node.children = []`. A **spec-conformant**
`POST` — canonical `Node`, children **embedded** — was therefore answered **`200 OK`
with its entire subtree deleted**. The client believed it had stored a tree; we had
stored a root. `422` only existed when `OSL_WOW_VALIDATE=1`, and **validation
is off by default**, so on the path most callers take the deletion was still silent.

**Silent data loss is the worst failure mode in this system.** A loud rejection is fine;
a quiet truncation the caller cannot detect is not. The check is now **structural** — it
lives in the store, not in the env-gated validation layer, so it holds on **every** path:

| Body | Before | Now |
|---|---|---|
| flat, leaf (`children: []` / omitted) | 200, stored | **unchanged** — 200, stored, byte-identical |
| canonical, children EMBEDDED | **200, subtree SILENTLY DELETED** | **422** `embedded_children_not_supported` (names `OSLFlatNode`, gives offending paths + remedies); **nothing stored** |
| canonical + `X-OSL-WoW-Node-Form: canonical` | n/a | **200** — whole subtree stored, ids assigned, **every** stored node returned, `X-OSL-WoW-Children-Flattened` reports the transform |
| integer child id-refs on POST | **200, SILENTLY DROPPED** | **400** `child_id_refs_not_supported_on_create` |
| `children` on PUT that restructures | **200, SILENTLY IGNORED** | **422** `child_restructure_not_supported` |
| `children` on PUT echoed unchanged (read-modify-write) | 200 | **unchanged** — 200 |

Rejecting outright would have dead-ended every conformant client; accepting-and-flattening
unconditionally would have made us accept a body our own published contract says we do not,
and would have turned the API into a silent "write canonical, read flat". **Reject by
default, flatten only when asked** keeps the published contract enforced *and* gives the
conformant client a labeled way through. Proven by section **G** of
`runtime/world-server/test/spatial-graph-proof.js`, which drives a
server built with `OSL_WOW_VALIDATE` **off**.

**Was deferred here; now DELIVERED (do not re-open):** serving the real `Spatial`
descriptor. shipped it as the versioned opt-in described
in **D2/D3** — `GET /wow/spatial/{spatialID}?form=descriptor` (or
`X-OSL-WoW-Spatial-Form: descriptor`) returns the canonical
`{id, rootNodeID, geoPose}`; the default response is unchanged.

**Now DELIVERED:** *declaring* that opt-in
in `wow-spec/schema.yaml` — the `form` query parameter, the
`X-OSL-WoW-Spatial-Form` request header, and the `X-OSL-WoW-Spatial-Form`
response header are declared on the `GET /wow/spatial/{spatialID}` operation, and
the `Spatial` schema stanza states it is served on the versioned opt-in. The
declaration and the served behavior are drift-guarded (bidirectionally) by
`src/wow-claim-drift-proof.mjs`.

### D8 — `SpatialFabricSubtree`: the address is WoW's, the contract is ours

See **§11** for the full statement. In one line: **"permitted" is not "specified."**

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
