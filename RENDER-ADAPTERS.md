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

The adapter copies the data and widens RGB to RGBA, because three.js has no
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

Intensity: the adapter was written for r160, which has no
`Scene.environmentIntensity`, and keeps the same method under 0.186.1. When the environment is
installed, `intensity` is written as `envMapIntensity` on every
`MeshStandardMaterial` and `MeshPhysicalMaterial` under `sceneRoot` that has no
own `envMap`. Prior values are remembered. They are restored when the
environment is cleared or replaced without intensity, when intensity is removed,
and on disposal. A value is restored only if it still holds the value the
adapter wrote.

Materials added after intensity was applied are not covered. They keep their own
`envMapIntensity` (default 1) until the next `setLighting` environment call.
There is no per-frame scan and no material hook in three.js that would cover them
without per-frame cost. Materials that are shared with objects outside the
scene also take the value.

The environment stays on the scene where it was installed. After `useScene` or
an owned-X3D document load (a `syncScene` that builds a new Scene), call
`setLighting` again.

Without a resolver, the adapter keeps the earlier behaviour. It reports
`environment.asset` and `environment.intensity` unsupported (status `limited`),
leaves the scene environment unchanged and retains authored lighting.

`src/render-adapter-environment-check.mjs` checks all of this with the actual
adapter, the bundled three.js 0.186.1 and a recording renderer. It also runs in-memory negative
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

## The Scene, the X3D importer and renderer revision 3 (engine milestone M1)

The engine contract is `docs/engine/SCENE-CONTRACT-V0.md` in the container
repository. The X3D reader and the drawing code share no file; the Scene is the
only thing passed between them. Under `runtime/scene-core/public/` (the
browser's `./vendor/scene-core/`):

- `core/math.mjs`: a one-line re-export of `render-adapter/spatial-math.mjs`, so
  the Scene, the importer and Interaction take their matrix math from `core/`,
  not from the renderer's folder. The file itself stays in `render-adapter/`,
  which kit 1.1.2 pins by content.
- `scene/scene.mjs`: the Scene, version 0: layers of plain data and the access
  calls `addLayer`, `removeLayer`, `setLayerVisible`, `get`, `find`,
  `worldMatrix`, `write`, `writeGeometry` and `changes` (version 0.2 adds
  `writePose`; see "Skins in the Scene" below). Three reading aids are
  added: `layers()`, `layer(name)` (a layer without its entities and assets) and
  `asset(name, kind, key)`.
- `scene/check.mjs`: the plain value checks, moved out of the X3D profile.
- `scene/manager.mjs`: the Scene Manager.
  - `loadLayer(scene, importer, source)` imports and adds one layer.
  - The document route's host and Interaction on a layer are now
    `createSceneHost` and `createLayerRuntime` (milestone M2, below). The
    X3D-named forwards of M1 are gone.
- `import/x3d/`: the X3D importer. `json-document.mjs` and `profile.mjs` are the
  reader and field list. `to-scene.mjs` turns a read document into one layer and
  a load report, and exports `x3dImporter`, whose `capabilities()` now holds the
  `x3d` entry the adapter used to report. A soft body's prepared surface is the
  body entity's own dynamic mesh.
- `interaction/sensors.mjs`: proximity sensors and links on `sensor` and `link`
  components, and `pickLink`, which turns the host's allowlist into refs, asks
  the renderer's `pick` and names the hit entity and its nearest link.
- `physics/bullet/soft-body.mjs`: the physics step, moved from `x3d/` with its
  step logic unchanged, and `createSceneSink(scene, layer)`: the sink the step
  writes through, as two Scene writes (a rigid body's transform, a soft body's
  `POSITION`).
- `render/three/scene-view.mjs`: the Three.js module's view of a Scene, moved
  from `x3d/scene-renderer.mjs`. It builds the same objects from Scene data,
  never writes the Scene and imports no reader. Each drawn object carries
  `userData.ref` (`{ layer, id }`) and `userData.source` (the entity's source).
- `assets/rgbe-decoder.mjs`: the HDR decoder, moved from `x3d/`.

`OwnX3dRenderAdapter` (`x3d/own-x3d-render-adapter.mjs`) keeps revision 2 and
adds revision 3:

- `attachScene(scene)` remembers the Scene and builds nothing.
- `syncScene()` applies `scene.changes` since the last call. Transforms and
  dynamic geometry change in place. A new Scene, or a changed layer stack, is
  rebuilt; a failed build keeps the previous view, and a successful one retires
  the previous view and the previews and skins drawn over it.
- `pick({ origin, direction, allowed })` answers with
  `{ ref, distance, point, normal }` or null; `allowed` lists refs.
- `detachScene()` frees everything built from the Scene. `attachedScene` reads
  the Scene the adapter is attached to.

`loadDocument`, `cancelDocument`, `stepDocument`, `activateAnchor`, `pickRay` and
`documentState` are gone from the adapter. No render adapter method takes an X3D
document. `web/own-x3d-document.mjs` loads the Scene Manager and passes the
application's `prepareWorld` to the importer; `web/own-x3d-ammo.mjs` stays in
`web/` for M1. The capability panel shows the chain in use, for example
"Source: X3D. Importer: X3D. Renderer: Three.js.", read from the layers of the
adapter's attached Scene.

The old paths `x3d/profile.mjs`, `x3d/json-document.mjs`,
`x3d/scene-runtime.mjs`, `x3d/scene-renderer.mjs`, `x3d/soft-body.mjs` and
`x3d/rgbe-decoder.mjs` are one-line forwards. `x3d/scene-runtime.mjs` now
forwards `createLayerRuntime`.

## The glTF importer and a document route that takes any importer (engine milestone M2)

Changed in milestone M2. Two formats now reach
the same renderer through the Scene.

- `import/gltf/`: the glTF importer, our own code (no Three.js, no renderer
  file, not Three.js's `GLTFLoader`). `read.mjs` reads a `.glb` or `.gltf`
  source into its JSON and buffers, and accessors into number arrays; a linked
  file comes only through the application's `resolve`, never a fetch.
  `to-scene.mjs` exports `gltfImporter` (format `"gltf"`). It copies scenes and
  nodes (ids `nodes/<i>`; a matrix becomes translation, rotation and scale),
  primitives (`POSITION`, `NORMAL`, `TEXCOORD_0`, `COLOR_0`, indices, mode;
  keys `meshes/<i>/primitives/<j>`), metallic-roughness materials with their
  five texture slots (`materials/<i>`), textures with their sampler
  (`textures/<i>`), images as their bytes and type (`images/<i>`), perspective
  cameras and `KHR_lights_punctual` lights.
  - Mode `"report"` keeps everything else in `extras.gltf` and lists it in the
    load report: skins, animations, morph targets, other attributes (for
    example `TANGENT`), other scenes, and every extension it does not read.
    Mode `"strict"` stops at the first such thing.
  - A file that needs a compressed-mesh or compressed-texture decoder
    (`KHR_draco_mesh_compression`, `EXT_meshopt_compression`,
    `KHR_texture_basisu`) is refused, with the reason in the error and its
    `report.refused`.
- `import/x3d/to-scene.mjs`: reading unchanged. `x3dImporter.capabilities()`
  gains a `reason`, and `import()` takes `options.onDocument(document)`, which
  hands the application the document it read (the route's portal window reads
  it).
- `scene/manager.mjs` names no format.
  - `createSceneHost({ renderer })` is the host for any importer:
    `load(source, { importer, mode, resolve, signal, options, navigation,
    centerOf, frame })`. `options` go to the importer (`preparePhysics` is
    wrapped so the host keeps what it prepared; `portalBindings` also go to
    Interaction). `navigation` is the application's request for a layer whose
    source has none; the host writes it to `layer.defaults.navigation` and
    leaves `layer.navigation` as the author wrote it (empty for glTF). `frame`
    writes a framed default camera to `layer.defaults.camera` (`framed: true`,
    with `position`, `rotation`, `yfov`, `znear`, `zfar`) for a layer with no
    camera entity; it is not an entity. A layer that authored both gets no
    `defaults`, so the X3D worlds are unchanged (Scene contract section 11,
    item 6). The state is `{ scene, layer, report, importer, runtime, realization,
    camera, generation }`.
  - `createLayerRuntime(scene, options)` is Interaction on one layer with its
    viewpoint list (from camera entities, else from `layer.defaults.camera`)
    and navigation list (the author's, else `layer.defaults.navigation`); `layerBounds(scene, layer)` is the box around what a layer
    draws.
  - Every layer the manager adds records its importer as `layer.importer`
    (`{ format, capabilities }`).
  - The X3D-named forwards that M2 kept in a marked block are gone: their
    three callers (`src/x3d-renderer-check.mjs`, `src/x3d-runtime-check.mjs`
    and `x3d/scene-runtime.mjs`) call `createSceneHost` and
    `createLayerRuntime`.
- `render/three/scene-view.mjs` also draws the `pbr` material (a
  `MeshStandardMaterial` set up as Three.js's glTF loader sets it up: linear
  factors, sRGB base colour and emissive maps, no vertical flip, glTF's sampler,
  normal-map green channel turned because the Scene has no tangents), meshes
  with `NORMAL`, `TEXCOORD_0` and `COLOR_0` and every glTF mode, and point and
  spot lights. It decodes texture images from the Scene's bytes with
  `createImageBitmap`. `root.userData.imagesReady` settles when they are
  decoded; `root.userData.notDrawn` lists what the view could not draw. The
  classic material and the X3D drawing are unchanged.
  - Navigation (the headlight) and the arrival camera fall back to
    `layer.defaults` when the layer has no authored navigation or camera.
  - A camera's `znear` and `zfar` are in the camera entity's own frame; the
    view multiplies them by the entity's world scale (Scene contract section
    11, item 7). Duck's camera sits under a 0.01 scale, so its near plane is
    0.01. A `null` `zfar` means no far limit; the view then uses 1000.
    `camera.userData.lens` records `{ near, far, farChosen, worldScale, from }`.
- `web/own-x3d-document.mjs` picks the importer by file type. Besides the two
  X3D worlds it admits `Duck.glb`, `BoomBox.glb`, `Lantern.glb` and
  `ToyCar.glb` from `web/assets/worlds/`, each by its SHA-256, for example
  `index.html?renderer=own-x3d&x3dDocument=Duck.glb`. glTF is read in report
  mode, with X3D's default navigation (headlight on) and a framed view when the
  file has no camera. The route waits for the texture images before it reports
  ready.
- `web/renderer-capability-panel.mjs` lists each shown layer's importer
  capabilities (the X3D importer's limit is counted again, closing M1's loose
  end), a count of what was not drawn from the open file with the list behind
  it, and the chain line, for example "Source: glTF. Importer: glTF.
  Renderer: Three.js.".

Two checks come with M2, both listed in `tools/run-checks-lists.mjs`:
`node src/importer-kit-check.mjs` (the importer conformance kit: the two X3D
worlds, the four glTF files and the hand-made files in
`src/fixtures/importer-kit/`, each with its expected layer saved as JSON, and
one planted fault per check) and `node src/engine-boundary-check.mjs` (the
engine boundary rules of M1 and M2, one planted fault per rule;
`--root <dir>` checks another copy).

## Skins in the Scene (engine milestone "skins in the Scene")

The Scene carries avatars as version 0.2 of the Scene contract
(`docs/engine/SCENE-CONTRACT-V0.md`, section 12, in the container repository)
defines them. The avatar format is `avatar-render/1`, unchanged.

- `scene/scene.mjs`:
  - A layer's assets gain `bodies`: each entry is one `avatar-render/1` bind
    description, as the avatar runtime's pose reader makes it.
  - The `skin` component is `{ body, pose }`: `body` is a key in the layer's
    `bodies`, `pose` the `avatar-render/1` completed pose. `addLayer` refuses a
    skin that names a missing body.
  - `scene.writePose(ref, pose)` replaces the entity's pose with a frozen copy
    and records one change of kind `"pose"`. It refuses an entity with no
    skin and a pose whose matrices are not 16 numbers. The full validation of
    the format stays with the renderer (`three-avatar-resources.mjs`).
  - The pose's `rootMatrix` places the body in the world: the entity's
    `transform` and the layer's `placement` do not apply to a skinned entity.
- `render/three/scene-view.mjs`:
  - When a skinned entity appears it builds the body with the adapter's
    `bindSkin`, adds its root under the view's root and applies the entity's
    latest pose with `setSkinPose`. A view started from revision 0 (a renderer
    swapped in) therefore shows each avatar as it stands.
  - A `"pose"` change applies the new pose in place.
  - A layer whose entities are all movers (a `skin`, and nothing drawn) and
    that sets no environment, navigation or defaults is a mover layer: adding,
    removing, showing or hiding it, or replacing it with the same name, is
    applied in place. A body whose entity stays with the same body is kept; a
    body whose entity goes or whose layer is hidden is freed with
    `disposeSkin`, once. A change to any other layer still rebuilds the view.
  - `bindSkin`, `setSkinPose` and `disposeSkin` (renderer contract revision 2)
    are unchanged; the scene view is their only caller on the document route.
- `web/scene-runtime-controller.mjs`, on the document route (a scene published
  with its engine Scene as `engineScene`):
  - Each frame the application adds the content layer `visitors`
    (`source.format: "application"`) with one entity per shown avatar
    (`visitor-<n>`, its body keyed the same), or writes each avatar's completed
    pose with `scene.writePose`, then calls the adapter's `syncScene` so the
    frame is drawn with this frame's pose, as before.
  - An avatar the application hides (its model or rig not visible) is left out
    of the layer, because the Scene has no visibility per entity; its body is
    freed and built again when it is shown.
  - The evaluator's own meshes stay hidden from the drawing (layer mask 0)
    exactly as on the ordinary path; the masking moved into one function both
    paths call.
  - The pose writer sits between `// document-route:begin` and
    `// document-route:end`. The Lab's ordinary worlds keep the present path
    (`bindSkin` and `setSkinPose` called by the controller).
- Today the document route creates no avatar layer (`web/app.js`,
  `mainX3dDocument`), so no avatar is drawn there yet; the path above is
  exercised by the scene view kit and a controller probe.

Checks:

- `node src/scene-view-kit-check.mjs`, the scene view kit, with kit 1.1.2's
  two-joint skin (`src/fixtures/scene-view-kit/two-joint-skin.json`, a byte
  copy): the bent pose moves the points as kit 1.1.2 expects; a view started
  from revision 0 after the bent pose shows it; a hidden `visitors` layer draws
  nothing; a body is freed once; `writePose` records one `"pose"` change. One
  planted fault per check. It is listed in `tools/run-checks-lists.mjs`.
- `node src/engine-boundary-check.mjs` rule 8: no engine file outside the
  renderer files, no line of `web/own-x3d-document.mjs` and no line of the
  controller's document-route block calls `bindSkin`, `setSkinPose` or
  `disposeSkin`. Rule 6 now reads all of `scene/manager.mjs`.

## One copy of the rig code (milestone "avatar parts get engine folders", step 1)

The rig code says which bone does which job and sets the avatar frame. It now
lives once, in the engine's processor folder `process/rig/`
(Processor contract, `docs/engine/PROCESSOR-CONTRACT-V0.md`, sections 1 and 2,
in the container repository). Moved, not redesigned.

- `process/rig/roles.mjs`: the roles, the role tables and rig recognition
  (`detectRig`). Byte copy of `web/avatar/runtime/fitting/roles.mjs` (the same
  in the avatars build).
- `process/rig/rig.mjs`: the avatar frame (`wrapFit`), one rest pose
  (`settleToBindPose`), `describeRig`, `rigFromBody`. Byte copy of the
  avatars build's `fitting/rig.mjs`, which differs from the old runtime copy
  in `strongestBoneVertices` only: an `includeShared` option, and a vertex
  whose two strongest skin weights are equal now counts for both bones.
- Both import only `three` (maths and scene-graph classes). Nothing in
  `process/` imports a renderer file, the Scene Manager, an importer or
  anything outside the engine.
- `web/avatar/runtime/fitting/roles.mjs` and `rig.mjs` are one-line forwards.
  A plain relative path cannot serve both Node (the files on disk) and the
  browser (`/vendor/scene-core/`), so each forward finds the engine folder
  beside the Scene Manager through `import.meta.resolve("#scene-manager")`,
  as `web/own-x3d-document.mjs` finds the importers: `index.html`'s import map
  in the browser, `package.json`'s `"imports"` in Node. A page that loads the
  avatar runtime needs `#scene-manager` in its import map.
- Not moved in this step: `holds.mjs`, `solvers.mjs`, `map-clips.mjs` (item
  placement, motion, clip mapping: later steps), and the avatars build's
  `body-details.mjs`, `measures.mjs` and `tools/measure-body.mjs`, which
  import `holds.mjs` and `map-clips.mjs` and so cannot sit in `process/`
  until those move.
- The runtime's `RELEASE.json` still pins the old bytes of the two forwarded
  files; the route check's `avatar-runtime` statement reports them until the
  release record is updated.

Checks: `node src/engine-boundary-check.mjs` rules 10 and 11. Rule 10: nothing
under `process/` imports a renderer file, the Scene Manager, an importer or a
file outside the engine. Rule 11: `process/rig/roles.mjs` and `rig.mjs` exist,
and no other `.mjs` or `.js` file in this code folder exports half or more of
either file's names unless it is a one-line forward to it. The frozen vendor
copy `web/vendor/avatar-evaluator-v1/fitting/` is allowed while nothing outside
`web/vendor/avatar-evaluator-v1/` imports it; the summary lists it as
`frozenCopies`.

## Clip mapping in the engine (milestone "avatar parts get engine folders", step 2)

Clip mapping plays a clip made for one rig on another rig, from the two rigs'
roles and rest poses. It now lives once, in `process/clips/map-clips.mjs`.
Moved, not redesigned: the file is the old runtime copy (the same as the
avatars build's) with one import path changed, `./roles.mjs` to
`../rig/roles.mjs`.

- It imports only `process/rig/roles.mjs` and `three`. Nothing in
  `process/rig/` imports `process/clips/`.
- Named exception to the Processor contract: `mapClip` takes and returns a
  three.js `AnimationClip` and `mapPoseAt` returns three.js `Quaternion`s, so
  three.js types still cross the call (lines 41, 208, 316, 334, 338, 347).
  The boundary check allows the `three` import here until the Scene's
  animation tracks are designed (Scene contract, section 8).
- `web/avatar/runtime/fitting/map-clips.mjs` is a one-line forward, found
  through `import.meta.resolve("#scene-manager")` as the rig forwards are.
  Its caller: `web/avatar/runtime/clip-library.mjs` line 30.
- The frozen copy `web/vendor/avatar-evaluator-v1/fitting/map-clips.mjs`
  stays, allowed by name while nothing outside its tree imports it.

## Item placement in the engine (milestone "avatar parts get engine folders", step 3)

Item placement says where a held, carried or worn item sits on a body. It now lives once, in
the engine's processor folder `process/items/` (Processor contract, section 3, "Item
placement"). Moved, with the face and back slots added; nothing redesigned.

- `process/items/holds.mjs`: the matrices: hold, carry, head, and now face (glasses, at the
  eye height in front of the face, scaled across so the arms clear the head) and back
  (backpack, behind the back's measured skin). The runtime copy plus the avatars build's
  face and back slots; its hand and hang scaling and depth share are later work.
- `process/items/placement.mjs`: refusals ("no eye height", "face too wide" added), records,
  grip pose, track groups (`GROUPS`, `groupOf`, `splitClip`), `canEquip`, the face fit
  (rays on the rest mesh) and the slots (`SLOTS`, `slotOf`).
- `process/items/head-seat.mjs`: the Lab layer's head-item seat rule as plain numbers;
  `web/avatar-equipment-layer.js` `seatHeadItem` measures the item and calls it.
- `process/mesh/mesh-math.mjs`: triangles of a skinned mesh and rays and distances
  against them (the avatars build's body-details mesh maths, byte for byte).
- None imports a renderer, the Scene Manager, an importer, a loader, the solvers or
  anything under `web/`. Loading items (`loadItemLibrary`), the stance and grip overlays
  and the `Equipment` class stay in the avatar runtime, whose `equipment.mjs` re-exports
  every moved name; `fitting/holds.mjs` is a one-line forward.
- The airport items (glasses, backpack) are in `web/assets/actionforge/items/airport/`
  with an empty `catalog-attachments.json`: not in the Lab's item menu yet. The engine
  route draws only items in the avatar binding's resources (the catalog's production
  items), so the menu step must add them there too.

Checks: `node src/engine-boundary-check.mjs` rules 13 to 16: no loader under
`process/items/`; no file but `process/items/holds.mjs` and `placement.mjs` defines
`fitHold`, `fitWorn`, `fitFace`, `fitBack`, `heldPlacement` or `itemRecord` (the frozen
vendor copy allowed by name); `process/items/` imports no solvers; `process/rig/`
imports nothing from `process/items/`.

## Body measuring in the engine (milestone "avatar parts get engine folders", step 4)

Body measuring reads a rigged body at rest and writes its body record (`osl-fitting-body/1`):
rig, roles, rest pose, bone lengths, height, hand hollows per grip pose, feet, head and torso
volumes, face and back measures. It now lives in the engine. Moved, not redesigned.

- `process/body/body-details.mjs`: `measureBody` and its helpers, the avatars build's
  `fitting/body-details.mjs` with its import lines changed; its mesh maths is
  `process/mesh/mesh-math.mjs` (no copy), whose names it re-exports. It imports
  `process/rig/`, `process/clips/map-clips.mjs` (grip poses on the body's rig),
  `process/items/holds.mjs` (grip frame, back anchor), `process/mesh/mesh-math.mjs` and `three`.
  It takes a loaded scene and plain data and returns plain data; no file path of its own.
- `process/items/measures.mjs`: `gripError`, `carryErrors`: how far a held item is from the
  hand's hollow on a live avatar (item placement).
- `runtime/scene-core/tools/measure-body.mjs` (Node only, beside the engine folder, with
  `node-context.mjs` and `in-place.mjs`): loads a GLB and writes `<id>.body.json`. The source
  rig, clip pack and item catalog are arguments (`--source-rig`, `--pack`, `--items`); the
  worktree has no source rig yet (`mannequin.glb`). The avatars build's `--update` mode is not
  moved. For adam and game-brute it writes the same record as the avatars build's tool, byte
  for byte except `measured_at`.
- Body measuring has its own folder, `process/body/`, because it reads the clip and item code;
  rules 12 and 16 keep `process/rig/` free of both, and rule 26 lets `process/body/` read
  `process/rig/`, `clips/`, `items/` and `mesh/` while none of those reads it.

Checks: `node src/engine-boundary-check.mjs` rules 17 to 21: body measuring and the item
measures import only three.js and their named engine files; nothing under `process/` imports a
`node:` module, a loader or the Node tools; nothing in the engine or under `web/` imports the
Node tools; a tool imports only `node:`, three.js, its own folder and `process/`;
`measureBody` and `gripError` each exist once.

## The motion driver and the movement model in the engine (milestone "avatar parts get engine folders", step 5)

The humanoid motion driver picks which clips play and how they blend; its fix-ups (plant-feet,
reach-hands, avoid-arms) run after the clips; the movement model moves the body over the floor
and runs the jump. The driver is an Animator module and the movement model a Navigation module
(MOVER-CONTRACTS-V0, section 1). Moved, not redesigned.

- `animation/drivers/humanoid/avatar-motion.mjs`: AvatarMotion (clip blending). It imports
  canEquip, GROUPS and splitClip from `process/items/placement.mjs` and STANCE_FADE_S from
  `solvers.mjs` beside it.
- `animation/drivers/humanoid/solvers.mjs`: SolverStack (the fix-ups), the runtime copy with
  three import paths changed (`process/rig/roles.mjs`, `process/rig/rig.mjs`,
  `process/items/holds.mjs`). The avatars build's torso-core avoidance (S1 to S8) is not carried:
  it needs body-details.mjs and changes every arm pose.
- `animation/drivers/humanoid/vendor/avatar-ik.mjs`: the leg and arm solver; it imports nothing.
- `animation/drivers/humanoid/driver.mjs`: the thin contract wrapper. bind(body, clipSet, tuning,
  style, { readPose }) makes AvatarMotion and SolverStack; step(dt, moverState, actions) runs the
  clips, then the fix-ups, and returns readPose(body); capabilities() gives kind, actions, gaits
  and speedRange_mps from the tuning; dispose() lets go of both. The application passes the pose
  reader (web/evaluated-avatar-pose.mjs) as a function; the driver imports nothing from web/.
  No caller uses it yet; the Lab's ActionForgeMotionDriver keeps its own sequence.
- `navigation/humanoid/locomotion.mjs`: Locomotion and createTuning, the same bytes.
- `three` crosses: AvatarMotion drives a three.js AnimationMixer, SolverStack writes three.js
  bones, Locomotion keeps a three.js Vector3 and Quaternion. Allowed until the Scene's animation
  tracks are designed.
- The runtime's avatar-motion.mjs, locomotion.mjs, fitting/solvers.mjs and
  fitting/vendor/avatar-ik.mjs are one-line forwards, found through
  import.meta.resolve("#scene-manager").
- Clip code still in the items folder: splitClip (with subClip and groupOf) is in
  process/items/placement.mjs; it moves to process/clips/ with a forward when that folder is
  next touched.

Checks: `node src/engine-boundary-check.mjs` rules 22 to 25: nothing under animation/ or
navigation/ imports a renderer file, the Scene Manager, an importer or anything outside the
engine; animation/ and navigation/ import nothing of each other; vendor/avatar-ik.mjs imports
nothing; AvatarMotion, SolverStack, Locomotion and the solver are defined once (the frozen
vendor copy allowed by name).

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

The source check uses the actual browser engine and the installed glTF/addon
loader, both three.js 0.186.1, matching the browser import map. Do not substitute another
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
