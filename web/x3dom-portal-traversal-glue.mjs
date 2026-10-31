// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-portal-traversal-glue.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: buildWowScene comes from x3d-wow-graph-stage.mjs (see that file); the RenderedTexture calls go through the adapter, so X_ITE shows previews too; a preview draws what its destination's bounded preview declares, read once when the portal is set up; each change has a comment that starts 'Lab'.

import { mountCanonicalWorldContent, mountCanonicalWorldLights } from "./vendor/scene-core/render-adapter/canonical-room.mjs";
import { buildWowScene } from "./x3d-wow-graph-stage.mjs";
import { syncHostedSceneObjectMeshesX3dom, disposeHostedSceneObjectMeshesX3dom } from "./x3dom-portal-hosted-objects.mjs";
import { glueCameraThroughFrames, normalizeVec3, subtract3, addScaled3, dot3, portalFrameForLocation } from "./live-adapter-portal-geometry.mjs";
import { mountAirportTerminalContentX3dom, terminalSignMesh } from "./x3dom-airport-terminal-scene.mjs";
import { X3D_PORTALS, ringColorsOf } from "./worlds-list.mjs";
import { withBase } from "./base-path.mjs";

// Phase 2 of the X3DOM render-parity plan — portal traversal.
//
// The backend-facing half of portal traversal (crossing detection, exit-intent/arrival POSTs,
// presence handoff, switching which world-server endpoint is active) needs NO new code here: it
// already runs unconditionally inside LiveAdapter itself (`createPortalTraversalHandoffController`,
// constructed in live-adapter.js's own constructor with every dependency it needs supplied
// internally) for both render paths, since x3dom-live-mode.mjs already drives the same
// `liveAdapter.stepAvatar()` every frame that the three.js path does. What was actually missing
// for X3DOM was purely the RENDERING reaction: nothing built a visible portal, and nothing
// listened for the "crossing" event LiveAdapter dispatches to rebuild the scene / remap the
// camera the way app.js's sceneRuntimeController + movementCameraController do for three.js. This
// module is that reaction, kept deliberately smaller than the three.js path's
// scene-runtime-controller.mjs + portal-spatial-preview.mjs: it rebuilds the (procedural,
// canonical) world content for whichever world is now active and gives the portal a real,
// findable position.
//
// Phase 6 added a preview through the aperture. Destination content for each portal is built in the
// same document as the main scene, as a child of the shared `adapter.sceneRoot`, staged at a large
// per-portal offset (STAGING_OFFSET_BASE_M below) far outside the player's view. A
// createRenderedTexture() handle attached as the aperture material's texture map draws that staged
// subtree, with its own nested viewpoint moved by glueCameraThroughFrames(). A RenderedTexture's
// `update` field can be set to "none" when the aperture is off screen (see isPreviewEligible() and
// tick() below), which pauses that portal's render pass.
//
// Lab change: what is staged is a bounded snapshot. The room is built once, from the nodes the
// destination's bounded preview declared when the portal was set up. It is not re-read; only the
// viewpoint looking at it moves.
//
// The one real, non-obvious cost of sharing a single document: X3D's Viewpoint zNear/zFar default
// to -1 ("automatic", recomputed every frame from the WHOLE scene's bounding volume) — staging
// content hundreds of meters away balloons that computation and wrecks depth precision for
// everything close to the player. Fixed by giving the MAIN viewpoint explicit zNear/zFar
// (web/index.html's #x3dom-viewpoint) and each RenderedTexture's own nested viewpoint explicit
// values too (X3DOMRenderAdapter.createRenderedTexture()'s fov/near/far options) — confirmed via a
// dedicated spike (spike-run-rendered-texture-zfar-check.mjs) that this fully bypasses the
// automatic computation and that staged content becomes genuinely invisible from the main camera
// once it's beyond the explicit far plane, not just "usually out of frame."
//
// Destination content comes from `liveAdapter.resolvePortalDestinationContent()`, as on the three.js
// path, and is drawn here through the adapter (applyBoundedPreview below). The one documented gap
// versus three.js: the airport-bound portal shows the terminal's storefronts and signs but not its
// travelers and staff.
//
// Portal apertures are rendered as a double-sided PLANE, not a thin box as originally built in
// this phase: a live capture-and-compare test (walking a real avatar up to a real portal,
// screenshotting it, then cloning the exact same live <imagetexture> node onto a fresh plane at
// the same position for a side-by-side) showed the box rendering fully opaque black — the
// texture never visibly applies to a Box's default UV mapping in this X3DOM build, regardless of
// material/lighting adjustments — while the identical texture renders correctly on a plane. Box
// was originally chosen specifically to dodge a single-sided-visibility limitation (a plane
// approached from its back would be invisible, since the adapter didn't wire a material's
// double-sided intent through to the plane geometry's own `solid` field) — but Phase 6 of this
// same plan already closed that gap (`side: "double"` now sets `solid="false"` on plane geometry
// via _wrapShape(), see x3dom-render-adapter.mjs), so requesting it here gets correct two-sided
// visibility AND working texture rendering, with no adapter changes needed.
const PORTAL_APERTURE_MATERIAL = Object.freeze({ type: "standard", color: 0x8fd4ff, opacity: 0.55, transparent: true, side: "double", unlit: true });
// Lab change: his fork used 160. Chrome gives X3DOM a WebGL 1 context here, where a texture whose side
// is not a power of two samples black under X3DOM's repeat wrap, so every aperture drew black.
const PORTAL_PREVIEW_SIZE_PX = 256;
// Lab change: the same interval as three.js's CLIENT_READ_INTERVAL_DEFAULT_MS (portal-render-controller.mjs),
// one read at a time. Ten reads a second queued in the browser on a slow link.
const ACTIVE_HOSTED_POINT_POLL_MS = 1000;
// Matches three.js's own MIN_PROJECTED_PORTAL_AREA_DEVICE_PX (portal-spatial-preview.mjs, not
// exported — restated here) — an intentionally low bar ("on screen at all, however small") rather
// than a real proximity gate; the real proximity requirement lives in a separate prefetch/warm-up
// subsystem this glue doesn't need to duplicate (the destination content is already resolved by
// the time a portal exists in the active world at all).
const MIN_PROJECTED_PORTAL_AREA_DEVICE_PX = 16;
// Matches three.js's own RADIAL_CLIP_PLANE_COUNT (portal-spatial-preview.mjs, not exported —
// restated here, same convention as the constants above).
const RADIAL_CLIP_PLANE_COUNT = 20;
// Lab addition: the look of a portal inside a preview, as in web/main-demo-preview.mjs, and of a plain primitive.
const COLOR_CLOSED_RING = 0x7a808c;
const COLOR_CLOSED_FACE = 0x2a2d33;
const COLOR_PLAIN_PRIMITIVE = 0x8fa3b8;
const CLOSED_RING_CENTER_Y = 1.35;
const CLOSED_RING_SCALE = Object.freeze([0.9, 1.4]);
const WAY_BACK_REACH_M = 0.25;
const X3D_PORTAL_RING_COLOR = 0xffb14d;
// What a preview shows outside the room it holds: X3DOM clears a RenderedTexture to black.
const PREVIEW_BACKGROUND_COLOR = 0x14385a;
// Where each portal's destination content gets staged within the SHARED main scene — far enough
// past the main viewpoint's explicit zFar (300, see web/index.html) that it's genuinely clipped
// from the player's own view (confirmed via spike-run-rendered-texture-zfar-check.mjs), not just
// "usually out of frame." Spaced per portal by index purely for debuggability (each RenderedTexture
// only ever renders its OWN scene-field-referenced subtree — see createRenderedTexture()'s own
// comment — so distinct offsets aren't required for correctness, only to keep staged content from
// visually coinciding if ever inspected directly).
const STAGING_OFFSET_BASE_M = 2000;
const STAGING_OFFSET_SPACING_M = 200;

function portalFrameMatrix(frame) {
    const right = Array.isArray(frame.right) ? frame.right : [1, 0, 0];
    const up = Array.isArray(frame.up) ? frame.up : [0, 1, 0];
    const forward = Array.isArray(frame.forward) ? frame.forward : [0, 0, 1];
    const position = Array.isArray(frame.position) ? frame.position : [0, 0, 0];
    // Column-major, matching spatial-math.mjs's convention (and three.js's Matrix4.elements):
    // columns 0-2 are the local X/Y/Z basis vectors, column 3 is translation.
    return [
        right[0], right[1], right[2], 0,
        up[0], up[1], up[2], 0,
        forward[0], forward[1], forward[2], 0,
        position[0], position[1], position[2], 1,
    ];
}

// Seen in a running page (2026-08-13), correcting this file's earlier wrong assumption: for a torus
// to be parallel to a wall, it needs to be a ring in the local X-Y plane with its hole looking down
// local Z — the SAME local-Z-face-normal convention portalFrameMatrix already uses for the aperture
// plane (see that function's own column order: right, up, forward → X, Y, Z), not a different
// hole-along-Y convention. So this is just portalFrameMatrix with right/up pre-scaled to the
// frame's width/height (mirroring three.js's `ring.scale.set(width/2, height/2, 1)` on a unit
// torus) — no separate axis remapping needed, and no manual rotation-attribute override either
// (an earlier version of this function swapped forward into the Y column and patched the result
// with a hardcoded `rotation` override, which only happened to look approximately right from one
// specific camera angle — wrong, as testing across multiple portals showed).
function portalRingMatrix(frame, widthM, heightM) {
    const right = Array.isArray(frame.right) ? frame.right : [1, 0, 0];
    const up = Array.isArray(frame.up) ? frame.up : [0, 1, 0];
    const forward = Array.isArray(frame.forward) ? frame.forward : [0, 0, 1];
    const position = Array.isArray(frame.position) ? frame.position : [0, 0, 0];
    const hw = widthM / 2;
    const hh = heightM / 2;
    return [
        right[0] * hw, right[1] * hw, right[2] * hw, 0,
        up[0] * hh, up[1] * hh, up[2] * hh, 0,
        forward[0], forward[1], forward[2], 0,
        position[0], position[1], position[2], 1,
    ];
}

// Lab change: the ring's colour is the destination's, from the list of worlds.
function destWorldRingColor(locationId) {
    return ringColorsOf(String(locationId || "")).color;
}

function worldPortals(world) {
    if (!world)
        return [];
    if (Array.isArray(world.portals) && world.portals.length)
        return world.portals;
    return world.portal ? [world.portal] : [];
}

// X3DOM-native gating, not a reuse of three.js's projectedPortalApertureDevicePixels
// (portal-spatial-preview.mjs) — that function uses raw THREE.Vector3/camera.matrixWorldInverse
// math with no X3DOM equivalent. Built instead on X3DOMRenderAdapter.worldToScreen(), which
// already returns canvas-pixel coordinates + an in-front/behind flag for a world point against the
// MAIN camera (not the destination one — this gates visibility from the PLAYER's real viewpoint,
// same as three.js's own gate). Projects the aperture's 4 corners, clips their screen-space
// bounding box against the actual canvas bounds (adapter.canvasSize), and returns the clipped
// area — NOT just the raw projected box: worldToScreen()'s `visible` flag only tests
// in-front-of-camera, not on-screen, so a portal squarely in front of the camera but entirely off
// to the side (well outside [0,width]) would otherwise still count as "eligible" with a large
// nonzero area (confirmed the hard way while building this function's own verification spike —
// see spike-run-x3dom-portal-preview-gating.mjs's header comment). Any corner behind the camera
// counts the whole aperture as not visible (a simplification — three.js's own version is more
// careful about partially-behind apertures, not worth replicating for a background preview).
function projectedApertureAreaPx(adapter, frame) {
    const center = Array.isArray(frame.position) ? frame.position : [0, 1.35, 0];
    const right = Array.isArray(frame.right) ? frame.right : [1, 0, 0];
    const up = Array.isArray(frame.up) ? frame.up : [0, 1, 0];
    const halfWidth = (Number(frame.width_m) || 1.8) / 2;
    const halfHeight = (Number(frame.height_m) || 2.8) / 2;
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const projected = signs.map(([sx, sy]) => {
        const corner = [
            center[0] + right[0] * halfWidth * sx + up[0] * halfHeight * sy,
            center[1] + right[1] * halfWidth * sx + up[1] * halfHeight * sy,
            center[2] + right[2] * halfWidth * sx + up[2] * halfHeight * sy,
        ];
        return adapter.worldToScreen(adapter.camera, corner);
    });
    if (projected.some((p) => !p || !p.visible))
        return 0;
    const { width: canvasWidth, height: canvasHeight } = adapter.canvasSize;
    if (!canvasWidth || !canvasHeight)
        return 0;
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    const clippedWidth = Math.max(0, Math.min(Math.max(...xs), canvasWidth) - Math.max(Math.min(...xs), 0));
    const clippedHeight = Math.max(0, Math.min(Math.max(...ys), canvasHeight) - Math.max(Math.min(...ys), 0));
    return clippedWidth * clippedHeight;
}

// Adds `offset` (a staging-group translation) onto a destination-local vector, needed everywhere
// a value computed in the destination content's own local coordinate frame (clip-plane centers,
// glueCameraThroughFrames() output, a content-kind's own default camera pose) gets written onto a
// RenderedTexture's viewpoint — which resolves position/orientation directly, with NO ancestor-
// transform composition (confirmed in Stage 0: createRenderedTexture()'s `scene` field takes the
// getViewMatrix() branch that skips it entirely — see that primitive's own comment) — so it must
// already be expressed in the SAME world-space frame the staging group's translation puts the
// actual destination content into.
function withStagingOffset(vec3, offset) {
    return addScaled3(vec3, offset, 1);
}

function transformPoint(m, [x, y, z]) {
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

export function createX3domPortalTraversalGlue({ adapter, liveAdapter, camera, log = () => { } }) {
    let worldContentGroup = null;
    let portalGroup = null;
    let previewRecords = [];
    let activeHostedGroup = null;
    let activeHostedMeshes = new Map();
    let activeHostedVersion = null;
    let activeHostedPollHandle = null;
    let x3dPortalsHere = [];
    let x3dPortalCrossed = null;

    function clearGroup(group) {
        if (!group)
            return;
        try {
            adapter.disposeNode(group);
        }
        catch (err) {
            log(`[x3dom-portal-glue] failed to clear group: ${err && err.message}`);
        }
    }

    function disposePreviews() {
        for (const record of previewRecords.splice(0)) {
            record.disposed = true;
            try {
                record.disposeContent?.();
            }
            catch (err) {
                log(`[x3dom-portal-glue] failed to dispose portal preview content: ${err && err.message}`);
            }
            try {
                adapter.disposeNode(record.stagingGroup);
            }
            catch (err) {
                log(`[x3dom-portal-glue] failed to dispose portal preview staging group: ${err && err.message}`);
            }
        }
    }

    // Bounds the destination content to a sphere around the awareness volume the destination
    // declares, so a player standing far from the source portal doesn't see a small, fixed-size
    // destination room rendered out of its own bounds.
    //
    // X3D's ClipPlane uses the identical ax+by+cz+d>=0-is-kept convention as THREE.Plane(normal,
    // constant), so this is the same 21-plane construction three.js's own
    // SpatialPortalPreviewManager builds (one forward "setback" plane so the back of the portal
    // isn't visible, plus RADIAL_CLIP_PLANE_COUNT Fibonacci-sphere-distributed radial planes
    // approximating a bounding sphere) — same math, different node type. Mounted once per portal
    // preview setup (boot + each crossing), not per frame — the awareness volume is anchored to the
    // portal's own fixed position, not the live camera.
    //
    // Mounted as children of `record.stagingGroup` — NOT of the shared `adapter.sceneRoot` — and
    // deliberately using the volume's LOCAL (un-offset) center/forward, matching ordinary X3D
    // transform-hierarchy semantics (a ClipPlane nested under a Transform is expressed in that
    // Transform's own local space, same as any geometry node). This keeps the clip volume's scope
    // structurally bounded to only this portal's own staged subtree — it can never affect sibling
    // content elsewhere in the shared main scene, regardless of whether the `plane` field's
    // coordinate-space semantics turned out to be local or world (verified live via screenshot, see
    // Stage 2's verification notes — a wrong guess here would show up as a mis-clipped preview, not
    // a leak into the real player-visible scene). Inserted BEFORE any destination content is
    // mounted (called from setupPortalPreview() ahead of the content-kind branch), since X3D's
    // ClipPlane scoping is traversal-order sensitive — it affects geometry that comes after it
    // among its siblings, not geometry that precedes it.
    function mountAwarenessClipPlanes(record, volume) {
        // Lab change: the volume is the one the destination's bounded preview declares. A flat preview has none.
        if (!volume?.valid || volume.flat)
            return;
        const center = volume.center;
        const forward = normalizeVec3(volume.forward, [0, 0, 1]);
        const forwardPlane = adapter.createClipPlane({
            normal: forward,
            constant: -dot3(forward, volume.plane_point || center) + volume.plane_setback_m,
        });
        adapter.add(record.stagingGroup, forwardPlane);
        // Lab change: the sphere needs more planes than X_ITE allows on a shape, so X_ITE keeps only
        // the forward plane above and its preview is not bounded by the sphere.
        if (adapter.clipPlaneLimit !== undefined && adapter.clipPlaneLimit < RADIAL_CLIP_PLANE_COUNT + 1)
            return;
        for (let index = 0; index < RADIAL_CLIP_PLANE_COUNT; index += 1) {
            const y = 1 - (index / (RADIAL_CLIP_PLANE_COUNT - 1)) * 2;
            const radial = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = index * Math.PI * (3 - Math.sqrt(5));
            const outward = [Math.cos(theta) * radial, y, Math.sin(theta) * radial];
            const plane = adapter.createClipPlane({
                normal: [-outward[0], -outward[1], -outward[2]],
                constant: dot3(outward, center) + volume.radius_m,
            });
            adapter.add(record.stagingGroup, plane);
        }
    }

    // Lab change: a preview is what its destination's bounded preview declares (web/main-demo-portals.mjs,
    // resolveBoundedPreview), the same data the three.js path draws in web/main-demo-preview.mjs. It is built
    // once, here: boxes, spheres and a grid at each node's matrix, each portal among them closed, and no lights,
    // because X3DOM's lights reach the whole document. A flat preview (an image, a colour, nothing, or an offline
    // destination) stays the RenderedTexture's plain background.
    function applyBoundedPreview(record, content) {
        record.contentLocation = content.location_id;
        record.contentKind = content.preview_kind;
        if (content.preview_kind !== "nodes")
            return;
        setInitialViewpointPose(record, [0, 1.6, 5], [0, 1.2, 0]);
        const root = adapter.createGroup("x3d-bounded-preview");
        adapter.setLocalMatrix(root, content.world_transform);
        adapter.add(record.stagingGroup, root);
        const terminal = content.nodes.some((node) => node.extension && node.extension.airport_terminal);
        if (terminal) {
            const graph = boundedPreviewGraph(content);
            const stagingView = Object.create(adapter);
            Object.defineProperty(stagingView, "sceneRoot", { get: () => root });
            const built = buildWowScene(graph, () => stagingView, {
                width: PORTAL_PREVIEW_SIZE_PX,
                height: PORTAL_PREVIEW_SIZE_PX,
                source: "portal_preview_x3d_bounded",
            });
            setInitialViewpointPose(record, built.camera_pose.position, built.camera_pose.lookAt);
            mountAirportTerminalContentX3dom(graph, adapter, { parent: root, document, partial: true });
        }
        record.hostedObjectIds = [];
        for (const node of content.nodes) {
            if (node.closed) {
                if (!isWayBack(content, node))
                    adapter.add(root, closedPortalMesh(node));
                continue;
            }
            if (node.extension && node.extension.authored_wow_content)
                continue;
            const mesh = primitiveNodeMesh(node);
            if (!mesh)
                continue;
            adapter.add(root, mesh);
            if (/^obj-/.test(String(node.label || "")))
                record.hostedObjectIds.push(String(node.label));
        }
    }

    // The graph the airport terminal reads, from the preview's flat list, as web/main-demo-preview.mjs builds it.
    function boundedPreviewGraph(content) {
        const [rootNode, ...others] = content.nodes;
        const nodes = {};
        for (const node of content.nodes) {
            nodes[node.id] = {
                id: node.id,
                label: node.label,
                localTransform: node.matrix,
                children: node === rootNode ? others.map((other) => other.id) : [],
                webofworlds_extension: { ...(node.extension || {}) },
            };
        }
        return { spatialID: content.arrival, root: rootNode.id, nodes };
    }

    // The portal a visitor would arrive through stands on the plane being looked through: the ring they look
    // through is its picture, so it is not drawn again across the opening.
    function isWayBack(content, node) {
        const way = content.window_frame && content.window_frame.ground_center;
        if (!content.join_in_preview || !way)
            return false;
        const world = transformPoint(content.world_transform, [node.matrix[12], node.matrix[13], node.matrix[14]]);
        return Math.hypot(world[0] - way[0], world[2] - way[2]) <= WAY_BACK_REACH_M;
    }

    function closedPortalMesh(node) {
        const group = adapter.createGroup(`x3d-portal-closed:${node.label || node.id}`);
        adapter.setLocalMatrix(group, node.matrix);
        const holder = adapter.createGroup("x3d-portal-closed-ring");
        adapter.setPosition(holder, 0, CLOSED_RING_CENTER_Y, 0);
        adapter.add(group, holder);
        const ring = adapter.createMesh(
            adapter.createGeometry({ type: "torus", innerRadius: 0.075, outerRadius: 1 }),
            adapter.createMaterial({ type: "standard", color: COLOR_CLOSED_RING, side: "double" }),
        );
        adapter.setLocalMatrix(ring, [CLOSED_RING_SCALE[0], 0, 0, 0, 0, CLOSED_RING_SCALE[1], 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        adapter.add(holder, ring);
        const face = adapter.createMesh(
            adapter.createGeometry({ type: "plane", width: CLOSED_RING_SCALE[0] * 2, height: CLOSED_RING_SCALE[1] * 2 }),
            adapter.createMaterial({ type: "standard", color: COLOR_CLOSED_FACE, side: "double" }),
        );
        adapter.add(holder, face);
        return group;
    }

    // `osl-primitive:box?size_m=0.8` with `osl-color:2bd4ff`, at the node's matrix. Lights, avatars and models are not drawn.
    function primitiveNodeMesh(node) {
        const match = /^osl-primitive:([a-z]+)(?:\?(.*))?$/i.exec(String(node.spatialAssetURI || ""));
        if (!match)
            return null;
        const params = new URLSearchParams(match[2] || "");
        const size = Number(params.get("size_m")) || 1;
        const color = /^osl-color:#?([0-9a-f]{6})$/i.exec(String(node.appearanceURI || ""));
        const material = () => adapter.createMaterial({ type: "standard", color: color ? parseInt(color[1], 16) : COLOR_PLAIN_PRIMITIVE, side: "double" });
        const shape = match[1].toLowerCase();
        let mesh = null;
        if (shape === "box")
            mesh = adapter.createMesh(adapter.createGeometry({ type: "box", width: size, height: size, depth: size }), material());
        else if (shape === "sphere")
            mesh = adapter.createMesh(adapter.createGeometry({ type: "sphere", radius: size / 2 }), material());
        else if (shape === "grid")
            mesh = adapter.createGridHelper({ size, divisions: Number(params.get("divisions")) || 12, colorCenterLine: 0xffffff, colorGrid: 0x88aacc, transparent: true, opacity: 0.28 });
        if (!mesh)
            return null;
        adapter.setLocalMatrix(mesh, node.matrix);
        return mesh;
    }

    // Sets the RenderedTexture viewpoint's initial pose (before any real crossing-based camera glue
    // takes over — see updateCameraGlue below) from a position/lookAt pair expressed in the
    // destination content's own LOCAL coordinates, offsetting into the staging area first.
    function setInitialViewpointPose(record, position, lookAt) {
        adapter.setCameraPose(record.rt.viewpoint, {
            position: withStagingOffset(position, record.stagingOffset),
            lookAt: withStagingOffset(lookAt, record.stagingOffset),
        });
    }

    async function setupPortalPreview(portal, material, index) {
        const stagingOffset = [STAGING_OFFSET_BASE_M + index * STAGING_OFFSET_SPACING_M, 0, 0];
        // The `def` attribute here is purely for debuggability (matches previewDebugState()'s
        // debug hooks and live DOM inspection) — the RenderedTexture's `scene` field is bound via a
        // direct node-reference assignment below (bindRenderedTextureScene()), NOT DOM DEF/USE.
        const stagingDefName = `x3dom-portal-staging-${index}`;
        const stagingGroup = adapter.createGroup(stagingDefName);
        if (typeof stagingGroup.setAttribute === "function")
            stagingGroup.setAttribute("def", stagingDefName);
        adapter.setPosition(stagingGroup, stagingOffset[0], stagingOffset[1], stagingOffset[2]);
        adapter.mountRenderedTextureStage(stagingGroup);

        // Created up front, before any destination content exists. Starts at update="none", NOT "always": until
        // bindRenderedTextureScene() below completes, the `scene` field is unset, which falls back
        // to rendering the MAIN scene (including the consuming aperture itself) — a real,
        // confirmed-live `GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active
        // Texture` during that window when this defaulted to "always". Flipped to "always" only
        // once binding actually succeeds — and tick()'s own eligibility-based toggle is gated on
        // record.sceneBound for the same reason: that loop sees this record from the moment it's
        // pushed below, well before this function's own bind below resolves, and was found to be
        // an independent source of the same early-flip race.
        const rt = adapter.createRenderedTexture({
            dimensions: [PORTAL_PREVIEW_SIZE_PX, PORTAL_PREVIEW_SIZE_PX, 4],
            update: "none",
            backgroundColor: PREVIEW_BACKGROUND_COLOR,
        });
        adapter.attachRenderedTexture(material, rt);

        const record = {
            stagingGroup, stagingOffset, stagingDefName, rt, updateMode: "none", sceneBound: false,
            material, portal, disposed: false, disposeContent: null, contentKind: null, hostedGroup: null, hostedObjectIds: [],
        };
        previewRecords.push(record);
        try {
            // Must complete before this RT is allowed to render at all — an unbound `scene` field
            // falls back to rendering the MAIN scene (see createRenderedTexture()'s own comment on
            // why the DOM USE/DEF path was replaced, and the update="none" comment just above).
            try {
                await adapter.bindRenderedTextureScene(rt, stagingGroup);
                if (record.disposed)
                    return;
                record.sceneBound = true;
                adapter.setRenderedTextureUpdate(rt, "always");
                record.updateMode = "always";
            }
            catch (err) {
                log(`[x3dom-portal-glue] bindRenderedTextureScene failed for portal preview ${index}: ${err && err.message}`);
            }
            if (record.disposed)
                return;
            let content = null;
            try {
                content = await liveAdapter.resolvePortalDestinationContent(portal);
            }
            catch (err) {
                log(`[x3dom-portal-glue] resolvePortalDestinationContent failed: ${err && err.message}`);
            }
            if (record.disposed)
                return;
            // The clip planes come first: X3D's ClipPlane reaches only what follows it among its siblings.
            mountAwarenessClipPlanes(record, content?.awareness);
            applyBoundedPreview(record, content || { preview_kind: "unreachable", location_id: portal.target_location_id || null });
        }
        catch (err) {
            log(`[x3dom-portal-glue] portal preview setup failed: ${err && err.message}`);
        }
    }

    // Lab addition: seen from behind, three.js shows no preview, only the open ring. A crossing lands the
    // third-person camera behind the portal it came out of, where the preview here covered the avatar with
    // whatever the glued view saw from outside the destination room, usually something dark.
    const apertureMeshes = new Map();
    function isCameraBehind(portal) {
        const pose = camera.currentPose();
        if (!pose || !portal?.frame)
            return false;
        return dot3(subtract3(pose.position, portal.frame.position), portal.frame.forward || [0, 0, 1]) < 0;
    }
    function hideAperturesFromBehind() {
        for (const [portal, mesh] of apertureMeshes) {
            const behind = isCameraBehind(portal);
            if (mesh._labBehind !== behind) {
                mesh._labBehind = behind;
                adapter.setVisible(mesh, !behind);
                mesh._labHidden = behind;
            }
        }
    }

    function mountPortalApertures() {
        apertureMeshes.clear();
        disposePreviews();
        clearGroup(portalGroup);
        portalGroup = adapter.createGroup("x3dom-portal-apertures");
        adapter.add(adapter.sceneRoot, portalGroup);
        let previewIndex = 0;
        for (const portal of worldPortals(liveAdapter.world)) {
            const frame = portal && portal.frame;
            if (!frame || !Array.isArray(frame.position))
                continue;
            const geometry = adapter.createGeometry({
                type: "plane",
                width: Number(frame.width_m) || 2,
                height: Number(frame.height_m) || 3,
            });
            const material = adapter.createMaterial(PORTAL_APERTURE_MATERIAL);
            const mesh = adapter.createMesh(geometry, material);
            adapter.setLocalMatrix(mesh, portalFrameMatrix(frame));
            adapter.add(portalGroup, mesh);
            setupPortalPreview(portal, material, previewIndex);
            apertureMeshes.set(portal, mesh);
            previewIndex += 1;

            addPortalRing(frame, destWorldRingColor(portal.target_location_id));
        }
        mountX3dPortals();
    }

    // Decorative frame, matching three.js's own dest-portal-ring (portal-spatial-preview.mjs)
    // — a glowing emissive torus around the aperture, colored per destination world.
    function addPortalRing(frame, ringColor) {
        {
            const ringGeometry = adapter.createGeometry({ type: "torus", innerRadius: 0.075, outerRadius: 1 });
            // side: "double" — seen in a running page (2026-08-13): without this, only the torus's
            // backfaces were visible (culled the wrong way round under this build's winding/normal
            // conventions for a Torus placed via setLocalMatrix's decomposed rotation). Same fix
            // already applied to the aperture plane for an analogous reason (see this file's header
            // comment) — disabling culling entirely sidesteps the exact mechanism rather than
            // needing to fully re-derive it.
            const ringMaterial = adapter.createMaterial({ type: "standard", color: ringColor, emissive: ringColor, emissiveIntensity: 0.72, side: "double" });
            const ringMesh = adapter.createMesh(ringGeometry, ringMaterial);
            adapter.setLocalMatrix(ringMesh, portalRingMatrix(frame, Number(frame.width_m) || 2, Number(frame.height_m) || 3));
            adapter.add(portalGroup, ringMesh);
        }
    }

    // Lab addition: portals that exist only on the X3D paths, from `x3d_portals` in the worlds file. Each opens an
    // X3D JSON world on this frontend's X3D world page, under the same engine. No world server stands behind it, so
    // the three.js path, the world servers and their portal lists do not know it; the crossing is a page load. It
    // shows the plain colour its data names, and a sign with its label.
    function mountX3dPortals() {
        x3dPortalsHere = [];
        for (const entry of X3D_PORTALS) {
            if (entry.world !== liveAdapter.activeEndpointKey)
                continue;
            const frame = portalFrameForLocation({ portalId: entry.portal_id, locationId: liveAdapter.world?.location_id, triggerPosition: entry.position });
            const face = adapter.createMesh(
                adapter.createGeometry({ type: "plane", width: frame.width_m, height: frame.height_m }),
                adapter.createMaterial({ type: "standard", color: entry.color, emissive: entry.color, opacity: 0.85, transparent: true, side: "double", unlit: true }),
            );
            adapter.setLocalMatrix(face, portalFrameMatrix(frame));
            adapter.add(portalGroup, face);
            addPortalRing(frame, X3D_PORTAL_RING_COLOR);
            const sign = terminalSignMesh(adapter, document, entry.label, "#133249", "#ffffff", frame.width_m * 0.8, frame.width_m * 0.2);
            adapter.setPosition(sign, frame.position[0], frame.position[1], frame.position[2] + frame.forward[2] * 0.03);
            adapter.add(portalGroup, sign);
            x3dPortalsHere.push({ ...entry, frame });
        }
    }

    function crossX3dPortalIfInside() {
        const position = liveAdapter.state?.avatar?.position;
        if (x3dPortalCrossed || !Array.isArray(position))
            return;
        const inside = x3dPortalsHere.find((entry) => Math.hypot(position[0] - entry.position[0], position[2] - entry.position[2]) <= entry.radius_m);
        if (!inside)
            return;
        x3dPortalCrossed = inside.portal_id;
        globalThis.location.assign(withBase(`/x3d-world.html?world=${encodeURIComponent(inside.x3d_world)}&renderer=${adapter.kind}`));
    }

    // Glues the RenderedTexture's own viewpoint to the main camera's REAL pose every tick, via
    // glueCameraThroughFrames (live-adapter-portal-geometry.mjs — genuinely pure vector math, no
    // engine coupling, the same function the three.js path uses for its own camera gluing), offset
    // into the staging area. Gives real walk-past parallax through the aperture. Deliberately does
    // NOT attempt three.js's pixel-perfect on-screen crop (THREE.Camera.setViewOffset + a custom
    // crop shader sampling a live render-target texture) — RenderedTexture has no built-in
    // viewport-offset field for the same trick. The aperture shows the destination viewpoint's
    // whole view mapped onto the texture, correctly parallaxing as the player moves, not a
    // pixel-accurate window.
    //
    // Investigated (not integrated): X3DOM's Viewpoint node does expose a public
    // setProjectionMatrix() escape hatch, and a hand-built off-axis (Kooima-style asymmetric
    // frustum) matrix injected through it DOES persist in the node's own internal state — but a
    // dedicated feasibility spike found the
    // actual rendered crop unreliable: it required manually forcing X3DOM's needRender dirty flag
    // to be visible at all (a genuine X3DOM render-loop gotcha, though likely moot in the real app
    // since the player camera is essentially always moving), and even then the cropped output
    // consistently missed the intended sub-rectangle, landing on empty space rather than the
    // targeted content. Root cause not isolated (candidates: an aspect-ratio mismatch between the
    // RT's own square dimensions and the crop-fraction source, or an X3DOM-side Y-axis convention
    // difference — this project already found a real, separate Y-flip quirk in RenderedTexture
    // output during the orientation-check work). Not safe to build on without further isolation.
    function updateCameraGlue(record) {
        if (!record.portal?.frame || !record.portal?.target_frame)
            return;
        const pose = camera.currentPose();
        if (!pose)
            return;
        const camFwd = normalizeVec3(subtract3(pose.lookAt, pose.position), [0, 0, -1]);
        const glued = glueCameraThroughFrames(record.portal.frame, record.portal.target_frame, pose.position, camFwd);
        if (!glued)
            return;
        const lookAt = addScaled3(glued.position, glued.forward, 2.5);
        adapter.setCameraPose(record.rt.viewpoint, {
            position: withStagingOffset(glued.position, record.stagingOffset),
            lookAt: withStagingOffset(lookAt, record.stagingOffset),
        });
    }

    // Proximity/visibility gating: skips camera-gluing AND flips the RenderedTexture's own `update`
    // field to "none" (genuinely pausing that portal's destination render pass — confirmed via
    // x3dom-full.js's renderRTPass(), which returns immediately for update="none") whenever the
    // aperture isn't visible enough to matter (three.js's own gate is purely geometric/on-screen
    // too, not real-world distance — see projectedApertureAreaPx's header comment). A genuine
    // capability improvement over the old hidden-host architecture, which had no adapter method to
    // pause a mounted <x3d> host's own render loop and kept rendering internally regardless of
    // gating — stated at the time as a partial, not full, saving. RenderedTexture closes that gap.
    function isPreviewEligible(record) {
        if (!record.portal?.frame)
            return true; // no frame to test against — fail open rather than silently going dark
        return projectedApertureAreaPx(adapter, record.portal.frame) >= MIN_PROJECTED_PORTAL_AREA_DEVICE_PX;
    }

    let previewTurn = 0;
    function tick() {
        // Lab change: one preview renders per frame, in turn. With three portals in view, three extra
        // scene passes every frame took a machine with no graphics card down to a frame or two a second.
        hideAperturesFromBehind();
        crossX3dPortalIfInside();
        previewTurn += 1;
        let recordIndex = -1;
        for (const record of previewRecords) {
            recordIndex += 1;
            if (record.disposed || !record.rt)
                continue;
            const eligible = isPreviewEligible(record);
            // Gated on record.sceneBound, not just `eligible`: this loop runs every frame and the
            // record is visible to it from the moment setupPortalPreview() creates it — well before
            // that function's own bindRenderedTextureScene() await resolves. Without the gate, an
            // early-eligible portal could flip `update` to "always" here while `scene` is still
            // unset, independently of (and racing) setupPortalPreview()'s own bind-then-flip
            // sequence — this was a real, confirmed source of the RenderedTexture-defaults-to-
            // main-scene feedback loop (see the comment above setupPortalPreview()'s own flip).
            const hasTurn = previewTurn % previewRecords.length === recordIndex;
            const desiredUpdateMode = eligible && record.sceneBound && hasTurn ? "always" : "none";
            if (record.updateMode !== desiredUpdateMode) {
                adapter.setRenderedTextureUpdate(record.rt, desiredUpdateMode);
                record.updateMode = desiredUpdateMode;
            }
            if (!eligible || !hasTurn)
                continue;
            updateCameraGlue(record);
        }
    }

    // The ACTIVE world's own hosted scene objects (simple backend-driven box/sphere placeholders —
    // three.js calls the equivalent state.rootMeshes) were never rendered anywhere in the X3DOM
    // path at all: this glue only ever synced hosted objects into PORTAL PREVIEW destinations
    // (applyLegacyWorldContent above). portal-render-controller.mjs's applyHostedPointToView()
    // handles both — its isActiveWorld branch runs the identical sync against `impl.scene`, keyed
    // on `live.activeEndpointKey`, refreshed by that module's own poll loop. Mirrored here
    // with the X3DOM-native sync function.
    function applyActiveHostedPoint(attachPoint, endpointKey) {
        if (!attachPoint || attachPoint.version === activeHostedVersion)
            return;
        activeHostedVersion = attachPoint.version;
        syncHostedSceneObjectMeshesX3dom({
            adapter,
            meshes: activeHostedMeshes,
            parent: activeHostedGroup,
            objects: attachPoint.value?.objects || [],
            version: attachPoint.version,
            // Real WoW-negotiated asset representations for the ACTIVE world's own hosted objects
            // only. A preview draws the plain shapes its bounded preview declares.
            fetchWowRepresentation: true,
            // Lab change: named by the world whose list this is. A poll sent before a crossing can answer after it.
            wowAssetBaseUrl: liveAdapter.demoProxyBase(endpointKey),
        });
    }

    function mountActiveHostedObjects() {
        if (activeHostedPollHandle != null) {
            clearInterval(activeHostedPollHandle);
            activeHostedPollHandle = null;
        }
        activeHostedMeshes = new Map();
        activeHostedVersion = null;
        activeHostedGroup = adapter.createGroup("x3dom-active-hosted-objects");
        adapter.add(worldContentGroup, activeHostedGroup);
        const key = liveAdapter.activeEndpointKey;
        // Lab change: an answer that arrives after the next crossing belongs to a room that is gone. One read at a time.
        const group = activeHostedGroup;
        let reading = false;
        const poll = () => {
            if (reading)
                return;
            reading = true;
            liveAdapter.demoReadAttachPoint(key).then((attachPoint) => {
                if (group === activeHostedGroup)
                    applyActiveHostedPoint(attachPoint, key);
            }).catch(() => { }).finally(() => { reading = false; });
        };
        poll();
        activeHostedPollHandle = setInterval(poll, ACTIVE_HOSTED_POINT_POLL_MS);
    }

    // Lab change: a world whose graph declares an airport terminal draws it, whatever the world is called.
    // liveAdapter.wowResolved() is a plain getter on LiveAdapter, filled during the normal boot and crossing.
    function activeAuthoredAirport() {
        const resolved = typeof liveAdapter.wowResolved === "function" ? liveAdapter.wowResolved() : null;
        const raw = resolved?.graph?.nodes;
        const nodes = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
        return nodes.some((node) => node?.webofworlds_extension?.airport_terminal) ? resolved : null;
    }

    function mountWorldContent() {
        clearGroup(worldContentGroup);
        worldContentGroup = adapter.createGroup("x3dom-world-content");
        adapter.add(adapter.sceneRoot, worldContentGroup);
        const airport = activeAuthoredAirport();
        let airportMounted = false;
        if (airport) {
            // Deliberately NOT buildWowScene here (unlike the portal-preview branch below) — that
            // function unconditionally owns "the whole scene" (background color, its own floor/
            // grid/lights) and is only safe against a dedicated, otherwise-empty destination
            // adapter. The active world shares ONE persistent adapter/scene across every crossing,
            // scoped via worldContentGroup the same way mountCanonicalWorldContent already is —
            // mounting airport content straight into that same group keeps that scoping intact.
            try {
                airportMounted = !!mountAirportTerminalContentX3dom(airport.graph, adapter, { parent: worldContentGroup, document });
                // Lab change: the terminal content has no lights of its own. It was lit in his fork by
                // the lights of the rooms staged for previews, which no longer carry any.
                if (airportMounted)
                    mountCanonicalWorldLights(adapter, worldContentGroup);
            }
            catch (err) {
                log(`[x3dom-portal-glue] airport terminal mount failed, falling back to canonical room: ${err && err.message}`);
            }
        }
        if (!airportMounted) {
            clearGroup(worldContentGroup);
            worldContentGroup = adapter.createGroup("x3dom-world-content");
            adapter.add(adapter.sceneRoot, worldContentGroup);
            mountCanonicalWorldContent(adapter, worldContentGroup, liveAdapter.world || {});
        }
        mountActiveHostedObjects();
        mountPortalApertures();
    }

    function reportCameraTransform() {
        const pose = camera.currentPose();
        if (!pose)
            return;
        liveAdapter.updatePreviewProjection({ position: pose.position, target: pose.lookAt, rotation_y: pose.lookYaw });
    }

    function handleCrossing(event) {
        const detail = (event && event.detail) || {};
        log(`[x3dom-portal-glue] crossing: ${detail.kind || "unknown"} — recomposing world content`);
        mountWorldContent();
        const applied = camera.applyCrossingCameraMapping(detail.camera_mapping);
        log(`[x3dom-portal-glue] crossing: camera ${applied ? "remapped through portal frames" : "kept as-is (no camera mapping in this record)"}`);
    }

    liveAdapter.addEventListener("crossing", handleCrossing);

    // For tests/diagnostics only — avatar/equipment glTF assets embed their own real
    // <imagetexture> elements internally (baseColor/normal/etc. maps), so counting texture
    // elements anywhere in the document isn't a reliable signal of THIS preview mechanism
    // specifically; this reports on the actual preview records instead. Deliberately returns only
    // plain, JSON-serializable fields — a caller that does `page.evaluate(() =>
    // portalGlue.previewDebugState())` and returns the WHOLE result directly (not post-processed
    // in-page first) needs this to survive Puppeteer's CDP round-trip; a raw DOM node in the
    // returned shape breaks that (confirmed the hard way: an earlier draft included
    // `destSceneRoot` here directly and it silently broke an existing spike that returns this
    // array as-is). Use debugDestSceneRoot()/debugHostedGroup() below for DOM access instead,
    // always processed to plain data within the SAME evaluate() call before returning.
    //
    // `ready` means the destination's content has been applied (contentKind set). `viewpointPosition` replaces the old architecture's `destCameraPosition` (same
    // shape — a trimmed "x y z" string — just reading the RenderedTexture's own nested viewpoint
    // instead of a separate destination adapter's camera). `updateMode`/`textureAttached` replace
    // `capturedUrl`/`captureAttempts`: there's no discrete capture step anymore to count attempts
    // of, so gating is verified directly via whether `update` is currently "always" or "none".
    function previewDebugState() {
        return previewRecords.map((record) => ({
            ready: !!record.contentKind,
            // Lab addition: which world this preview was asked to show, and what that world's server gave it.
            target: record.portal?.target_location_id || null,
            contentLocation: record.contentLocation || null,
            hostedObjectIds: record.hostedObjectIds || [],
            cameraBehind: isCameraBehind(record.portal),
            apertureHidden: apertureMeshes.get(record.portal)?._labHidden === true,
            textureAttached: !!record.rt,
            updateMode: record.updateMode || null,
            contentKind: record.contentKind || null,
            viewpointPosition: record.rt && typeof record.rt.viewpoint.getAttribute === "function"
                ? (record.rt.viewpoint.getAttribute("position") || "").trim()
                : record.rt ? String(record.rt.viewpoint.node.position) : null,
            eligible: record.portal?.frame ? isPreviewEligible(record) : null,
        }));
    }

    // For tests/diagnostics only — live DOM references. Must be walked/reduced to plain data
    // within the SAME page.evaluate() call that fetches them; never return them as-is.
    function debugDestSceneRoot(index) { return previewRecords[index]?.stagingGroup || null; }
    function debugHostedGroup(index) { return previewRecords[index]?.hostedGroup || null; }

    return {
        mountWorldContent, reportCameraTransform, tick, handleCrossing, previewDebugState,
        debugDestSceneRoot, debugHostedGroup,
        x3dPortals: () => x3dPortalsHere.map((entry) => ({ portal_id: entry.portal_id, label: entry.label, position: entry.position, x3d_world: entry.x3d_world })),
        dispose: () => {
            liveAdapter.removeEventListener("crossing", handleCrossing);
            if (activeHostedPollHandle != null) {
                clearInterval(activeHostedPollHandle);
                activeHostedPollHandle = null;
            }
            disposeHostedSceneObjectMeshesX3dom(adapter, activeHostedMeshes);
            disposePreviews();
        },
    };
}
