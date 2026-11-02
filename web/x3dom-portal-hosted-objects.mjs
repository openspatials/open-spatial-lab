// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-portal-hosted-objects.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: none, except where a comment says so. X_ITE uses this file too.

import { accessLabelX3d, hostedAccessOf } from "./hosted-access-label.mjs";

// X3DOM-native sibling to portal-render-controller.mjs's syncHostedSceneObjectMeshes() — NOT a
// reuse of that function. It hardcodes `new ThreeRenderAdapter(THREE)` and reaches past the
// adapter for raw three.js APIs (`mesh.material.color.copy()`, `mesh.geometry.dispose()`,
// `mesh.parent.remove()`, `mesh.visible =`), none of which exist on X3DOM's plain-DOM-element mesh
// handles (X3D materials have no live `.color` object to copy into; disposal/visibility go through
// the adapter's own `disposeNode()`/`setVisible()`). Confirmed by reading the three.js version
// directly while planning the X3DOM portal-preview real-content work.
//
// Deliberately drops a few three.js-only concerns not relevant to a hidden destination-preview
// scene: render layers / `setLayerRecursive` (raycast-layer visibility, used by the three.js
// path's overhead drag view, which has no X3DOM equivalent), `preservePositionForId` (drag-in-
// progress position preservation — nothing drags objects inside this hidden preview), and
// `configureMesh` (a generic per-mesh hook the three.js call sites use for airport-proxy
// suppression, not needed here).
function disposeMesh(adapter, mesh) {
    try {
        adapter.disposeNode(mesh);
    }
    catch { /* best-effort, matches the three.js sibling's own try/catch-and-ignore */ }
}

function buildSyntheticMesh(adapter, objectId, shape, sizeM, color) {
    const geometry = shape === "sphere"
        ? adapter.createGeometry({ type: "sphere", radius: sizeM / 2 })
        : adapter.createGeometry({ type: "box", width: sizeM, height: sizeM, depth: sizeM });
    const mesh = adapter.createMesh(geometry, adapter.createMaterial({
        type: "standard",
        color,
        roughness: 0.55,
        metalness: 0.1,
    }));
    adapter.setName(mesh, `demo-scene-object-${objectId}`);
    return mesh;
}

// Per-object WoW-asset load bookkeeping (status/ready-promise), keyed by object_id — attached
// directly to the caller's `meshes` Map instance rather than threaded through as a second param,
// since every call site already owns exactly one `meshes` Map for the life of a sync target and
// this avoids changing that Map's own value shape (still a bare node handle per object_id, so
// every existing consumer — the dispose loop below, any future caller doing meshes.get(id) —
// keeps working unmodified).
function wowStatusMap(meshes) {
    return meshes.__wowStatus || (meshes.__wowStatus = new Map());
}

// Lab addition: a hosted object whose asset is not public carries its access above it (web/hosted-access-label.mjs).
// The label is a child of the object's mesh, kept here by object_id with the access and size it was drawn for.
function syncAccessLabel(adapter, meshes, objectId, mesh, access, sizeM) {
    const labels = meshes.__accessLabels || (meshes.__accessLabels = new Map());
    const key = access === "public" ? null : `${access}:${sizeM}`;
    const held = labels.get(objectId);
    if (held && held.mesh === mesh && held.key === key)
        return;
    if (held && held.mesh === mesh && held.label) {
        adapter.remove(mesh, held.label);
        disposeMesh(adapter, held.label);
    }
    const label = key ? accessLabelX3d(adapter, globalThis.document, access, sizeM) : null;
    if (label)
        adapter.add(mesh, label);
    labels.set(objectId, { mesh, key, label });
}

export function syncHostedSceneObjectMeshesX3dom({ adapter, meshes, parent, objects, version = null, fetchWowRepresentation = false, wowAssetBaseUrl = null }) {
    if (!adapter || !parent || !(meshes instanceof Map)) {
        return { object_ids: [], created: 0, removed: 0, geometry_updated: 0, structure_changed: false };
    }
    const statusMap = wowStatusMap(meshes);
    const seen = new Set();
    let created = 0;
    let removed = 0;
    let geometryUpdated = 0;
    for (const definition of Array.isArray(objects) ? objects : []) {
        if (!definition?.object_id)
            continue;
        const objectId = String(definition.object_id);
        const shape = definition.shape === "sphere" ? "sphere" : "box";
        const sizeM = Math.max(0.15, Number(definition.size_m) || 0.5);
        const color = adapter.createColor(String(definition.color || "#8899aa"));
        seen.add(objectId);
        // Density-fixture objects (OSL_FABRIC_DENSITY_FIXTURE, up to ~53 per location) are a perf/
        // QA stress-test tool, not WoW-compliance test subjects — always synthetic, regardless of
        // fetchWowRepresentation, so this feature can't compound with that one and exhaust the
        // 32-slot Inline pool (already near capacity with avatars/equipment/peers — see
        // x3dom-peer-avatars-glue.mjs's own MAX_PEERS cap for the same reason).
        const isFixture = !!(definition.fixture || definition.synthetic_density_fixture);
        // Lab change: an asset the world will not serve (the attach-point names it restricted or hidden) is never
        // requested; the object is drawn as itself, from its definition.
        const access = hostedAccessOf(definition);
        const wantsWowFetch = fetchWowRepresentation && !isFixture && !!wowAssetBaseUrl && access === "public";
        let mesh = meshes.get(objectId);
        const held = statusMap.get(objectId);
        if (mesh && access !== "public" && held && (held.status === "loading" || held.status === "loaded")) {
            adapter.remove(parent, mesh);
            disposeMesh(adapter, mesh);
            meshes.delete(objectId);
            statusMap.delete(objectId);
            mesh = undefined;
        }
        if (!mesh && wantsWowFetch) {
            const url = `${wowAssetBaseUrl}/wow/asset/primitive-${encodeURIComponent(objectId)}`;
            let claim = null;
            try {
                // Short explicit timeout (createInlineAsset's own default is 15000ms, tuned for
                // legitimately large/slow asset downloads): a 403/404 response — the COMMON case
                // here, not an edge case, given the demo's own restricted/hidden convention (see
                // wow-asset.js) — never produces valid content for createInlineAsset()'s own
                // load-detection poll to notice, so it would otherwise spin for the FULL default
                // timeout before rejecting. With the Inline-load queue serializing multiple
                // objects' claims (Phase 3.5a hardening), two back-to-back 403/404s could
                // otherwise leave hosted objects visibly missing from the scene for up to 30
                // real seconds before falling back — confirmed empirically during this feature's
                // own verification spike. 4s is comfortably longer than a real localhost HTTP
                // round-trip but short enough that the fallback feels immediate to a player.
                claim = adapter.createInlineAsset(url, {}, 4000);
            }
            catch (err) {
                // Pool exhausted (or any other synchronous claim failure) — fall straight back to
                // synthetic geometry for this object rather than losing it from the scene.
                claim = null;
            }
            if (claim) {
                mesh = claim.node;
                adapter.setName(mesh, `demo-scene-object-${objectId}`);
                adapter.add(parent, mesh);
                meshes.set(objectId, mesh);
                statusMap.set(objectId, { status: "loading" });
                created += 1;
                claim.ready.then(() => {
                    const entry = statusMap.get(objectId);
                    if (entry)
                        entry.status = "loaded";
                }).catch((err) => {
                    // 403/404/406 (the demo's own first-two-objects-per-location restricted/hidden
                    // convention — see wow-asset.js — makes this the COMMON case, not an edge case)
                    // or any other fetch/parse failure: drop the failed Inline claim and rebuild
                    // this object as synthetic geometry, same as if fetchWowRepresentation had
                    // never been requested. Only acts if this object_id is still the one we
                    // claimed for (a rapid dispose/re-sync could have already moved on).
                    if (meshes.get(objectId) !== mesh)
                        return;
                    try {
                        // disposeNode() on a pool-backed Inline wrapper deliberately does NOT
                        // remove it from the DOM (it releases the pool slot in place — see
                        // x3dom-render-adapter.mjs's own disposeNode() comment) — explicit
                        // removal first is required here, or the stale, now-placeholder-content
                        // node is left as an orphaned sibling of the new fallback mesh, doubling
                        // this object's visible/inventoried presence (confirmed empirically: a
                        // failed fetch produced 2 DOM nodes for the same object_id).
                        adapter.remove(parent, mesh);
                        adapter.disposeNode(mesh);
                    }
                    catch { /* best-effort */ }
                    const fallback = buildSyntheticMesh(adapter, objectId, shape, sizeM, color);
                    adapter.add(parent, fallback);
                    meshes.set(objectId, fallback);
                    statusMap.set(objectId, { status: "denied-or-error", error: err && err.message });
                });
            }
        }
        if (!mesh) {
            mesh = buildSyntheticMesh(adapter, objectId, shape, sizeM, color);
            adapter.add(parent, mesh);
            meshes.set(objectId, mesh);
            statusMap.set(objectId, { status: "synthetic" });
            created += 1;
        }
        const entry = statusMap.get(objectId);
        const isWowManaged = entry && (entry.status === "loading" || entry.status === "loaded");
        if (!isWowManaged && (mesh.userData.hostedSceneObject?.shape !== shape ||
            mesh.userData.hostedSceneObject?.size_m !== sizeM)) {
            adapter.setGeometry(mesh, shape === "sphere"
                ? adapter.createGeometry({ type: "sphere", radius: sizeM / 2 })
                : adapter.createGeometry({ type: "box", width: sizeM, height: sizeM, depth: sizeM }));
            geometryUpdated += 1;
        }
        // Recoloring/regeometrying only applies to locally-built synthetic meshes — a WoW-fetched
        // representation's appearance comes from the server-generated document itself (and the
        // server's own asset cache is never invalidated once populated — see wow-asset.js's
        // invalidate(), called nowhere — so there's nothing meaningful to react to here even if a
        // future definition.color changed).
        if (!isWowManaged)
            adapter.recolorSubtreeMaterials(mesh, color);
        // Lab change: the access label (see syncAccessLabel).
        if (!isWowManaged)
            syncAccessLabel(adapter, meshes, objectId, mesh, access, sizeM);
        // Position/visibility/userData apply unconditionally, every tick, regardless of load state
        // (still-loading, loaded, or synthetic-fallback) — this is what keeps a hosted object
        // tracking live position updates (demoMoveSceneObject / ambient republish drift) without
        // ever needing a re-fetch.
        const position = Array.isArray(definition.position) ? definition.position : [0, 0, 0];
        adapter.setPosition(mesh, Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
        adapter.setUserData(mesh, "hostedSceneObject", {
            object_id: objectId,
            shape,
            size_m: sizeM,
            color: `#${adapter.colorToHexString(color)}`,
            version,
            wow_status: entry ? entry.status : "synthetic",
            asset_access: access,
        });
        // Skipped while still "loading": createInlineAsset() manages this mesh's own visibility
        // internally (stays hidden until the requested content has actually swapped in — see its
        // own comment), specifically to avoid showing the claimed Inline pool slot's stale
        // placeholder content (equip-crown.glb) while the WoW-negotiated fetch is in flight.
        // Forcing it visible here unconditionally, every 100ms poll tick, undid that and made the
        // placeholder visibly render for the whole load window — confirmed live (a real "crowns in
        // the destination worlds" report). Every other status (loaded / denied-or-error /
        // synthetic) already has its real, final content in place, so forcing visible here is both
        // correct and necessary for those.
        if (!isWowManaged || entry.status !== "loading")
            adapter.setVisible(mesh, true);
    }
    for (const [id, mesh] of [...meshes.entries()]) {
        if (seen.has(id))
            continue;
        disposeMesh(adapter, mesh);
        meshes.delete(id);
        statusMap.delete(id);
        meshes.__accessLabels?.delete(id);
        removed += 1;
    }
    return {
        object_ids: [...seen],
        created,
        removed,
        geometry_updated: geometryUpdated,
        structure_changed: created > 0 || removed > 0,
    };
}

export function disposeHostedSceneObjectMeshesX3dom(adapter, meshes) {
    if (!(meshes instanceof Map))
        return 0;
    const count = meshes.size;
    meshes.forEach((mesh) => disposeMesh(adapter, mesh));
    meshes.clear();
    if (meshes.__wowStatus)
        meshes.__wowStatus.clear();
    meshes.__accessLabels?.clear();
    return count;
}
