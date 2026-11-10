# Rendering in the Lab

`web/application-state.mjs` projects the existing LiveAdapter's committed world,
room, identity, access, selection and network state. It does not maintain another
world store. `web/application-core.mjs` schedules input, avatar evaluation, camera
presentation, completed-pose publication, previews and the main draw in that
order. Stop, restart and disposal invalidate every phase of an older frame.

Three.js draws procedural and authored worlds through the existing
`runtime/scene-core/public/render-adapter/three-render-adapter.mjs`. Each mounted
world uses one renderer and main depth buffer. Preview targets use that renderer;
the selector's separate preview widget has its own canvas and lifecycle.
`movement-camera-controller.mjs` owns plain input, camera modes, smoothing and
crossing policy. Its three.js bridge measures head/camera positions as arrays and
reports a plain mount token; engine cameras, grounding and ray tests stay in
`three-camera-bridge.mjs`, `three-avatar-grounding.mjs` and
`three-camera-occlusion.mjs`. Shared behavior never compares scene object identity.
The application scene description retains canonical world/graph records and
projects light and label values for the existing builders; it is not another store.
Scene construction, geometry, materials and portal surfaces remain renderer-owned.

## Selecting a renderer

The existing `chooseRendererAtBoot`/registry resolves `?renderer=` and its aliases.
Use its returned fallback record in UI; do not introduce another alias table.
Changing engines requires a page reload. With no `?renderer=` the page reads no
switch and loads no X3D boot-path file (X3DOM or X_ITE engine, live mode, glue,
X3D world page); `app.js` still imports the registry, whose modules under
`render-adapter/` (including the X3DOM and X_ITE adapter classes, which carry no
engine) load on the default page. `tools/renderer/proof.mjs` checks exactly this.
The player bar reports the active
adapter's capabilities, current settings and explicit limits. Existing X3D
players retain their separate boot path; this stage does not integrate or change
them. An additional renderer's name and source location must be supplied before
its implementation is registered.

## Implementing the existing contract

Extend `RenderAdapter`; do not create a competing interface or a simulation
clock. Mount once, await `ready()`, construct renderer-owned handles, then accept
core frame calls. Three.js mount is synchronous and its ready promise resolves
immediately. Async adapters must reject stale loads after disposal or replacement.
The application's `composeScene` awaits readiness before invoking construction.
Replacement and disposal revoke pending preparations and release their private
surface. The ready three.js graph is adopted and attached at publication; its
internal constructor stays synchronous. Client-scene resolve, begin, enter,
commit and rollback ordering belongs to application state. LiveAdapter retains
identity/state ownership, and renderer preparation supplies plain ground facts
plus an opaque prepared handle. This readiness path does not qualify X3D players.

Capabilities state supported, limited, unsupported or untested, with effective
levels, reasons and evidence scope. Node existence is not rendering proof.
Current picking and full portal optical parity are not generic adapter guarantees.

`bindSkin(asset, rig)` returns an opaque supported binding or an explicit reason.
The rig contains stable joint IDs, parents, bind-local matrices and mesh-skin-bind
inverse matrices. The Lab bridge reads completed poses after the existing avatar
step. Root is holder-to-world; joints are local to the nearest mapped parent (or
holder for roots), including intervening non-bone transforms. Attachment matrices
are holder-relative. All matrices are column-major, in metres. Apply completed
matrices directly; never start another clip mixer or refit equipment in a renderer.
The current three.js fast path shares the evaluated graph and preserves its
matrix update ownership.

### Explicit reference input (revision 1)

`readAvatarBindDescription(instance, items)` in `evaluated-avatar-pose.mjs` now
includes an `avatar-render/1` resource description captured by the Lab-owned
`avatar-render-resources.mjs`. Neither module advances animation or fits an item.
The producer modules and distributed assets remain unchanged. Resource tables
are captured once per instance; the seven item templates are captured once per
item library. Arrays and typed buffers in this description are read-only inputs.
They are transferable with `structuredClone`; they contain no engine objects,
images, functions or source-node references. Adapters copy buffers they own.

| Field | Interpretation |
|---|---|
| `jointIds`, `parentJointIds`, `parentIndices` | Stable ordered joint keys. Parent IDs may refer forward; reject missing parents/cycles. A pose must use the identical order and parents. |
| `bindLocalMatrices` | Column-major joint matrices relative to nearest mapped parent, or holder for a root; skipped non-bone ancestors are included. |
| `resources.geometries` | Indexed vertex attributes with component count, normalized flag and copied typed storage. Position/normal, UV channels, color, tangent and four skin indices/weights retain source meaning. Groups and draw range retain primitive/material boundaries. |
| `resources.materials` | Linear color/emissive values; metallic/roughness factors; alpha opacity/test/blending, sidedness, depth flags, vertex colors, normal scale/space, AO intensity and texture channel IDs. Actual catalog materials use metallic-roughness PBR. |
| `resources.textures` | Decoded RGBA8 source-order pixels, dimensions, UV matrix/channel, wrap/filter/mipmap/anisotropy, flip/premultiply flags. `srgb` color maps decode to linear in the shader; `data` normal/metal/roughness maps do not. No engine texture is accepted. |
| `resources.meshes` | Stable traversal ID, local matrix relative to named parent joint or holder, geometry/material IDs and rendering flags. Each skin retains its own joint order, inverse-bind matrices, bind/inverse-bind matrices and attached/detached bind mode. |
| `resources.items[itemId]` | The same static mesh/resource description in the item root frame. It carries no guessed grip, body offset or animation. |
| completed pose | Holder-to-world `rootMatrix`; mapped-joint local matrices; final fitted `attachments[].itemMatrix` and `parentMatrix` in holder coordinates, with item/catalog keys. Metres and column-major conventions are explicit. |

`ThreeRenderAdapter.bindSkin(description)` realizes independent bones, meshes,
geometries, materials, pixel buffers and textures. It returns an opaque binding
with a root handle usable by `add`/`setVisible`. `setSkinPose(binding, pose)` applies
the full completed pose, including world-root conversion when mounted below a
transformed parent, and updates existing item handles. `disposeSkin(binding)`
releases its resources once and detaches the root. Adapter disposal retires all
bindings; cross-adapter or retired updates fail. Validation completes before pose
mutation. Unknown/malformed resources fail with a field-specific error instead
of silently producing a rigid or untextured substitute. Morph input is rejected;
the current four avatar/seven equipment files contain no morphs.

The legacy `bindSkin(threeGraph, rig)` / `setSkinPose(binding, jointMatrices)`
overload remains for the shared-graph fast path. Select `?avatarRender=explicit`
on the normal three.js application URL to exercise the independent reference.
The registry, world composition, controls, camera, clock and depth buffer stay
the same. Completed local/peer poses bind once; removed avatars and retired
scenes dispose bindings. Original mesh draw masks are suppressed and restored
without disabling evaluator transforms or changing camera visibility policy.
`avatar_resource_path` reports which path is active. The selector widget and
authored airport actors retain their existing rendering paths; their independent
resource integration is a separate qualification, not implied by this option.

The reference preserves actual alpha-blended double-sided hair, normal maps and
equipment vertex colors. Browser capture uses native decoded images and a 2D
RGBA8 readback; translucent pixels can undergo canvas premultiply roundoff.
Common-app image comparison must establish the useful rendered result. The Node
fixture decodes actual embedded WebP images with Pillow and proves numerical
resource/material equivalence; it cannot certify browser raster output.

`setLighting` accepts neutral key/fill colors, intensities and key direction,
exposure, and shadow enabled/mapSize/bias. Environment descriptions use an asset
URI, never a renderer texture.

Environment loading goes through a host resolver. The adapter never fetches.
`setEnvironmentResolver(resolver | null)` is a base-class method with a safe
default. Every adapter stores the resolver. It returns `supported: true` only
when the adapter's capability report has `features.environment.resolver ===
"supported"`. Today only the three.js adapter, and the owned X3D adapter that
extends it, report that. The method is not in the required-method list, so the
X3DOM and X_ITE adapters still cover the interface.

The resolver is called as `resolver(uri, { signal })`. It returns a Promise of
`{ kind, width, height, data }`:

- `kind` is `"equirect-linear-rgb"` or `"equirect-linear-rgba"`.
- `width` and `height` are positive integers.
- `data` is a `Float32Array` of linear radiance with exactly
  `width * height * channels` finite values.
- Rows run from top (+Y) to bottom, like an image file.
- `signal` aborts when a newer request, a clear or adapter disposal supersedes
  the load.

The adapter copies the data and widens RGB to RGBA, because r160 has no
`RGBFormat`. The host may reuse its array. The result is a `DataTexture`
(`FloatType`, `RGBAFormat`, `LinearSRGBColorSpace`, `flipY`, mapping
`EquirectangularReflectionMapping`, `needsUpdate`) set as
`sceneRoot.environment`. WebGLRenderer makes the PMREM itself, and it frees that
PMREM when the texture is disposed. No explicit `PMREMGenerator` is used.
Filtering is linear only when the renderer reports `OES_texture_float_linear`.
Otherwise it is nearest, because a linear float texture without that extension
samples black.

With a resolver, `setLighting({ environment: { asset, intensity } })` starts
resolution at once and returns synchronously. The result has
`environmentStatus` and `environmentReady`:

- `"loading"`: the overall `status` is `"loading"` and `supported` is false.
  `environmentReady` resolves (it never rejects) to
  `{ status: "applied" | "failed" | "discarded", asset, supported, reason? }`.
  When the current request settles, the adapter's latest lighting result
  becomes `supported` with status `"applied"`, or `limited` with status
  `"failed"` and `environment.asset` (and `environment.intensity`, when given)
  in `unsupported`.
- `"applied"`: the same asset is already installed on the current scene. Only
  the intensity is reapplied.
- `"cleared"`: the result of `environment: null`.

Data with a bad kind, size, length, type or a non-finite value fails. A resolver
rejection or synchronous throw also fails. On failure the previous environment
and its intensity are kept. A negative or non-finite intensity, or an empty URI,
throws before anything changes.

Ownership:

- The adapter disposes only textures it created.
- An owned texture is disposed exactly once: on replacement (after the new one
  is installed), on `environment: null`, or on adapter `dispose()`.
- `ThreeRenderAdapter.dispose()` and `OwnX3dRenderAdapter.dispose()` each call
  `releaseThreeEnvironment(this)` once. In `ThreeRenderAdapter.dispose()` a
  release failure does not stop the rest of the cleanup; it is rethrown after it.
- A result that arrives after a newer request, a clear or disposal is
  discarded. No texture is built or installed for it.
- `environment: null` still removes any scene environment, but it never disposes
  one that the host installed.
- If the host has replaced the owned texture on the scene, release disposes the
  owned texture and leaves the host's texture in place.

Intensity: r160 has no `Scene.environmentIntensity`. When the environment is
installed, `intensity` is written as `envMapIntensity` on every
`MeshStandardMaterial` and `MeshPhysicalMaterial` under `sceneRoot` that has no
own `envMap`. Prior values are remembered. They are restored when the
environment is cleared or replaced without intensity, when intensity is removed,
and on disposal. A value is restored only if it still holds the value the
adapter wrote.

Materials added after intensity was applied are not covered. They keep their own
`envMapIntensity` (default 1) until the next `setLighting` environment call.
There is no per-frame scan and no material hook in r160 that would cover them
without per-frame cost. Materials that are shared with objects outside the
scene also take the value.

The environment stays on the scene where it was installed. After `useScene` or
an owned-X3D `loadDocument`, call `setLighting` again.

Without a resolver, the adapter keeps the earlier behaviour. It reports
`environment.asset` and `environment.intensity` unsupported (status `limited`),
leaves the scene environment unchanged and retains authored lighting.

`src/render-adapter-environment-check.mjs` checks all of this with the actual
adapter, bundled r160 and a recording renderer. It also runs in-memory negative
controls. This proves ownership and material state, not PMREM output, GPU
upload or pixels. No browser or GPU qualification was done for this change.

Canonical and authored builders consume the shared scene description's exact
light values, including authored light nodes and their parent transforms. These
world lights remain the single authority; do not add a second set merely to
exercise `setLighting`. Graph normalization and light parsing share the same
renderer-free source through the browser import map and Node package imports.

Rendered textures support `ALWAYS`, `NEXT_FRAME_ONLY` and `NONE`. Bind a destination
scene and camera, then request a frame. Restore the previous render target and
clear state, dispose targets exactly once, and stop if callbacks retire the mount.
The existing portal manager also uses `renderScene` for its filtered destination
compositions. This is local preview rendering, not a promise of cross-engine parity.

## Evaluator distribution and verification

`web/vendor/avatar-evaluator-v1` is the active versioned evaluator distribution.
Its runtime logic is preserved; public packaging removes private comments and
provenance only. The Lab wrapper consumes one held and one worn evaluated item;
extra items retain the legacy representation. Known shield, mug and headwear
fit limitations remain. Original inactive `web/avatar/runtime` files are retained
until integration acceptance permits their bounded removal; they are not a
second active evaluator path.

Run the application-core, application-state, application-boundary and render-adapter-contract checks,
affected client checks, release closure and trace checks. Browser qualification
must additionally show actual local/airport rendering, animated avatars,
equipment, portal preview/crossing, settings and cleanup. Contract test renderer
recorders prove ordering and lifecycle, not pixels. Keep the existing browser
runner and isolated ports when executing these checks.

## Executable reference qualification

The source check uses the actual browser r160 engine with the installed r173
glTF/addon loader, matching the browser import map. Do not substitute another
dependency version for qualification. Node 22, installed dependencies and Python
with Pillow/WebP support are needed for the source fixture:

The normal, fast and client check selections include both application-boundary
and avatar-resource checks. The existing runner supplies the bundled-engine
loader for the resource check. Its decoder prerequisite fails explicitly if
Python, Pillow or WebP support is unavailable; set `PYTHON` to the intended
interpreter. A missing prerequisite is not a skipped or passing qualification.

```sh
node --loader ./tools/renderer/node-fixture-loader.mjs src/avatar-resources-check.mjs
node src/application-core-check.mjs
node src/application-state-check.mjs
node src/application-boundary-check.mjs
node src/render-adapter-contract-check.mjs
node tools/verify-release.mjs
node tools/trace-check.mjs
```

The real-input check derives all four current avatar prepared-file paths from
the catalog block, loads their unchanged libraries/clips/bodies and the seven
accepted item templates, and compares skinned vertices, shader normals, material
channels and fitted item matrices under transformed parents. It rejects malformed
resources and complete poses. Rest-only joints, lost bind space, bad fit, missing
normal maps and wrong color interpretation must break the comparison. It also
checks independent buffers, cache ownership and exactly-once binding disposal.
Synthetic controls additionally cover effective mesh visibility, scalar and
array material groups, and rejection of unsupported physical extensions.
Each captured mesh carries a required boolean `visible`, including visibility
of every ancestor through the captured asset root. This is immutable resource
visibility; whole-avatar visibility remains the runtime presentation policy.
Scalar material meshes may retain any geometry group indices because three.js
uses the scalar material for the draw. Material arrays must cover every group
index. Only default, unextended `MeshPhysicalMaterial` values are accepted as
standard materials: nondefault extension values (including iridescence, IOR,
clearcoat, sheen, transmission and specular controls) fail with the field name.
This reference does not silently approximate those extensions.
Boundary checks retain delayed/failed readiness, replace/cancel/late completion,
in-frame disposal, render-target restoration and single-clock coverage.
They also verify that changing a prefetch-ring radius or removing an additional
ring disposes its own geometry and material once, while same-radius reuse and
unrelated scene resources remain intact.

Portal completion observes the optional arrival POST and debug count for at most
the existing 15-second answer limit. It sends one POST, never retries it, and
reports an unanswered or rejected POST as an unknown remote outcome. An accepted
POST remains accepted if the debug observation fails or times out; the count is
then unavailable. Visual commit and crossing dispatch remain adjacent, before
ordered source departure and destination registration. The registration result
determines completion; optional observations cannot delay those presence calls.
Reset or a newer crossing revokes old controller
continuations, including late observation, error, profile and presence actions.
This does not cancel remote writes or promise bounded completion of signature,
promotion, equipment or presence providers. Providers retain ownership of their
own in-flight side effects. `src/portal-traversal-lifecycle-check.mjs` exercises
the real controller with controlled providers and virtual deadlines, including
reset during provider waits. It is in normal, fast and client selections; it
does not replace integrated crossing qualification.

`tools/renderer/reference-qualification.mjs` reuses the existing isolated Lab
runner and a supplied pinned situation checker. Run it through the project's
browser wrapper after checking the local port reservation and current listeners:

```sh
node tools/renderer/reference-qualification.mjs --checker "$CHECKER" --out "$OUTPUT" --scratch "$SCRATCH" --port-base 37419 --path explicit
```

The wrapper must set `HEAVY_RUN_SLOT_COUNT=2`; the runner refuses an unwrapped
invocation. It uses one new scratch/profile directory, ports 37419–37423, one
browser client and only its own process cleanup. Repeat the named wrong-file
control with `--plant wrong-file` and a distinct output directory. Use
`--path shared-three` for the existing reference comparison when required.
The pinned checker retains the seven-situation definitions and original motion,
file-identity and arms-down thresholds; the source packet's commands select only
the two local three.js situations. An omitted engine is untested, never a pass.

| Revision 1 obligation | Current consumer/check and remaining qualification |
|---|---|
| Selection/readiness | Existing registry/`chooseRendererAtBoot`, capability panel, `applicationState.composeScene`; state/boundary delayed/failure/replace checks. Candidate browser must confirm selected engine/path and no hidden substitution. |
| Scene/resources | `applicationState.sceneDescription` / `describeObjects`, canonical/authored builders and client-scene preparation; boundary description/bounds checks. Authored geometry remains three-native presentation; another adapter must consume the same committed IDs/access semantics. |
| Coordinates/poses | Read-only bridge → `bindSkin` / `setSkinPose`; real four-avatar nonidentity-root/bind checks and independent buffers. Browser must show completed-frame rendering, not initial-load samples. |
| Skin/equipment | Real weighted skin and all seven fitted attachment inputs with deformation/normal/material controls. Browser must qualify useful motion, catalog identity, occlusion and fit visibility; known fitting limits are not repaired here. |
| Materials/lights | Explicit PBR textures/materials; shared scene-description lights consumed by existing builders with parent transforms; `setLighting` controls exposure/shadow settings. Environment URI loading goes through a host resolver into an equirectangular float `DataTexture`; intensity is mapped to `envMapIntensity` on scene standard/physical materials present when it is applied. Only source-level checks exist; rendered output, GPU upload and the host resolver/decoder require browser qualification, and other engines must fill their own mappings. |
| Camera/portals/picking | Plain movement/camera policy with existing three presentation/portal manager and destination composition. Existing boundary/camera checks do not qualify native optical parity or generic picking; aperture/near clipping, destination light isolation and stable access-filtered hits require candidate rendered checks. |
| Frames/cadence | `application-core` ordering and generation checks; explicit publication adds no clock. Shared quality/preview controls remain existing consumers; candidate browser must measure pause/hide and effective preview cadence. |
| Lifecycle/errors | Adapter resource ownership and frame guards, application transaction cancellation and immediate private preparation release; source checks include planted mask/retirement faults and cached resource controls. Candidate browser must confirm no contexts/listeners/canvases survive disposal or replacement. |
| Capabilities | Existing panel separates active adapter report from requested selection. Numerical reference results do not qualify another engine; per-engine reports must retain exact bundle, implemented coverage, observed evidence and unresolved required outcomes. |

The accompanying reference manifest pins this source closure, dependency and
fixture hashes, command/checker versions, expected outcomes and remaining native
qualifications. A limit label does not waive any required behavior.

## Application presentation owners

The scene runtime publishes terminal readiness through
`publishTerminalReadyWorld(spatialId)`; a null ID clears both the general world
attribute and airport alias. A disposed runtime cannot republish readiness.
Application boot and both scene clear paths use that same method.

`live-viewport-controller.mjs` owns viewport listeners, DPR media-query rearming,
the single coalesced resize callback and its cleanup. It resizes the existing
scene runtime and invokes the application’s layer/camera resize callback. It
does not own animation or another rendering loop.

`application-debug-projection.mjs` consumes read-only current facts; app assembly
still invokes the existing camera and preview owners before projection.
`application-debug-dataset.mjs` publishes the existing attribute contract.
Motion, world and prefetch panel modules own only their DOM sections and share
`application-debug-format.mjs` and `application-debug-writer.mjs`. Prefetch panels
return notification inputs to the existing application notification owner.
Neither panels nor projection acquire network or protocol authority.

The registered application-debug and live-viewport source checks retain captured
payload/DOM output, null/false/zero distinctions, DPR and frame cleanup controls.
Scene boundary checks invoke the actual terminal publisher through failed,
replaced and retired preparations. App boot, actual resize and terminal rendering
still require the corresponding integrated browser qualification.

`application-status-panel.mjs` owns connection and equipment presentation and
the pending return-button guard. Its phase panel owns orientation and phase
toasts; both use the existing notification controller and canonical handoff
phases. The fabric notification publisher deduplicates event inputs before
publishing to that controller. The root state callback keeps scene/peer updates,
one canonical projection, world/crossing presentation and status in that order.

`application-boot.mjs` awaits the existing adapter, session, scene and avatar
owners, checking the application lifetime after each await. Root listeners
remain in the root cleanup list. The scene runtime owns graph presentation,
including pending model publication, controls, portals and live inclusions.
Disposal revokes late publication and closes only those owned resources. The
scene, avatar, movement and panel driver modules expose the existing debug
surface through current owner reads and commands; they introduce no state store.

The scene runtime also owns peer presentation. The existing peer reducer still
decides membership and self-identity; a replacement or retired layer cannot
publish a late avatar variant. Movement owns crossing diagnostics and camera
state. A diagnostic failure does not prevent presentation of an already
committed destination. None of these owners adds an animation clock.

The registered status, boot, assembly and peer checks compare captured outputs,
exercise actual owner calls and plant named failures. They cover session/hash
intent, asynchronous readiness, cancellation, rejection and cleanup at source
level. Useful pixels, input, crossing and network behavior still require the
independent integrated checks.

LiveAdapter crossing manifest surfaces use the existing signing and identity
authorities. Its world reader returns graph data; host operation guards prevent
stale reads from adopting host fields, including preview reads. This guard does
not establish cancellation of every calling navigation continuation. Server
portal, world, user, view, region and chunk projections retain the existing
runtime's protocol and signing inputs. Their registered source checks do not
replace HTTP/WebSocket qualification.
