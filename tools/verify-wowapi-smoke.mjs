// Web of Worlds API smoke test: a fast, pure-HTTP check of the OpenSpatialWorld surface this
// repository implements, against the running world servers. Adapted from Nicholas Polys's fork
// of this repository.
//
// What the upstream specifications define, and what this checks:
//   - OpenUserManifest and OpenSpatialAsset are read-only (GET/HEAD), and so is this server.
//   - OpenSpatialWorld defines writes: POST/PUT/DELETE on /wow/spatial/{spatialID}/node/{nodeId}
//     (section 4) and DELETE /wow/user/{userId} (section 4b). A userId is either this location's
//     own hosted identity (the spec's 400 "Invalid user value") or a live presence-registry
//     player, removed through the same path as a player's own departure.
//   - Each location runs one backend that serves all three services, so "service availability"
//     means each location's backend is healthy.
//   - None of the specifications define search or discovery endpoints (section 6).
//
// It starts the local topology with the repository's launcher and stops it at the end. Set
// OSL_FRONTEND_PORT and OSL_BACKEND_{A,B,LOBBY,AIRPORT}_PORT to run on isolated ports.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_PORTS = {
    a: Number(process.env.OSL_BACKEND_A_PORT) || 18151,
    b: Number(process.env.OSL_BACKEND_B_PORT) || 18152,
    lobby: Number(process.env.OSL_BACKEND_LOBBY_PORT) || 18153,
    airport: Number(process.env.OSL_BACKEND_AIRPORT_PORT) || 18154,
};
const BASE_A = `http://127.0.0.1:${BACKEND_PORTS.a}`;

function run(script, args = []) {
    const repoRoot = ROOT;
    // bash from PATH; on Windows, Git for Windows' bash. OSL_BASH_PATH overrides either.
    const bashPath = process.env.OSL_BASH_PATH || (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash");
    const scriptPath = join(repoRoot, script);
    const result = spawnSync(bashPath, [scriptPath, ...args], { cwd: repoRoot, encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`${script} failed\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

const checks = [];
function record(name, ok, detail) {
    checks.push({ name, ok, detail });
}
async function probe(url, opts) {
    const res = await fetch(url, opts);
    let body = null;
    try {
        body = await res.json();
    }
    catch { /* not all responses are JSON (e.g. binary asset bytes) */ }
    return { status: res.status, headers: res.headers, body };
}

// ---- 1. Service availability + a couple of section-9 performance smoke checks ----
async function checkServiceAvailability() {
    for (const [key, port] of Object.entries(BACKEND_PORTS)) {
        const t0 = performance.now();
        const { status, body } = await probe(`http://127.0.0.1:${port}/healthz`);
        const elapsedMs = performance.now() - t0;
        record(`availability:${key}:healthz-200`, status === 200 && body?.ok === true, { status, location_id: body?.location_id, elapsedMs: Math.round(elapsedMs) });
        record(`performance:${key}:healthz-under-500ms`, elapsedMs < 500, { elapsedMs: Math.round(elapsedMs) });
    }
}

// ---- 2. Auth & authorization — real cases only. There is no 401 path in this API: unauthorized
// access to a restricted/hidden asset answers 403/404 (the OpenSpatialAsset existence-concealing
// contract), never a generic "unauthenticated" response, since nothing here requires a session to
// even attempt a request. ----
async function checkAuthAndAuthorization() {
    const { body: scene } = await probe(`${BASE_A}/demo/scene-objects`);
    const objects = scene?.objects || [];
    if (objects.length < 3) {
        record("auth:scene-objects-available", false, { count: objects.length });
        return { openAssetId: null };
    }
    // wow-asset.js marks objs[0] restricted and objs[1] hidden by construction (see runtime/world-server/src/wow-asset.js) — objs[2] is the plain, unrestricted case.
    const restrictedId = "primitive-" + objects[0].object_id;
    const hiddenId = "primitive-" + objects[1].object_id;
    const openId = "primitive-" + objects[2].object_id;

    const restricted = await probe(`${BASE_A}/wow/asset/${encodeURIComponent(restrictedId)}`, { headers: { Accept: "model/x3d+xml" } });
    record("auth:restricted-asset-403-without-token", restricted.status === 403, restricted.body);

    const hidden = await probe(`${BASE_A}/wow/asset/${encodeURIComponent(hiddenId)}`, { headers: { Accept: "model/x3d+xml" } });
    record("auth:hidden-asset-404-existence-concealed", hidden.status === 404, hidden.body);

    const unacceptable = await probe(`${BASE_A}/wow/asset/${encodeURIComponent(openId)}`, { headers: { Accept: "application/pdf" } });
    record("auth:unacceptable-media-type-406", unacceptable.status === 406, unacceptable.body);

    const open = await probe(`${BASE_A}/wow/asset/${encodeURIComponent(openId)}`, { headers: { Accept: "model/gltf+json" } });
    record("auth:open-asset-200-with-negotiated-type", open.status === 200 && open.headers.get("content-type") === "model/gltf+json", { status: open.status, contentType: open.headers.get("content-type") });

    return { openAssetId: openId };
}

// ---- 3. Contract validation — reuses the server's own ajv validation, surfaced via the
// X-OSL-WoW-Validation response header (the same mechanism tools/verify-demo.mjs relies on). ----
async function assertValidated(url) {
    const res = await fetch(url);
    const validation = res.headers.get("X-OSL-WoW-Validation");
    const ok = res.status === 200 && !!validation && validation.startsWith("pass:");
    record(`contract:${url.replace(BASE_A, "")}`, ok, { status: res.status, validation });
    return res.status === 200 ? await res.json() : null;
}
async function checkContractValidation() {
    const world = await assertValidated(`${BASE_A}/wow/world`);
    await assertValidated(`${BASE_A}/wow/user/1`);
    await assertValidated(`${BASE_A}/wow/view/1`);
    const portalCount = Number(world?.portals?.portal_count) || 0;
    for (let id = 1; id <= portalCount; id += 1)
        await assertValidated(`${BASE_A}/wow/portal/${id}`);
    const spatialId = world?.id || null;
    let rootNodeId = null;
    if (spatialId) {
        const rootNode = await assertValidated(`${BASE_A}/wow/spatial/${encodeURIComponent(spatialId)}`);
        rootNodeId = rootNode?.id ?? null;
        for (const nodeId of [rootNode?.id, ...(rootNode?.children || [])].filter((value) => value != null))
            await assertValidated(`${BASE_A}/wow/spatial/${encodeURIComponent(spatialId)}/node/${nodeId}`);
    }
    return { world, spatialId, rootNodeId };
}

// ---- 4. CRUD smoke coverage. Real for the one resource the spec defines full CRUD for:
// POST (create) / GET (read) / PUT (update) / DELETE on /wow/spatial/{spatialID}/node/{nodeId}.
// Creates a real throwaway node under the graph's root and deletes it again in a finally block —
// this mutates live server state (in-memory, reset on restart), so cleanup must run even if a
// mid-lifecycle assertion fails, not just on the happy path.
async function checkCrudCoverage(spatialId, parentNodeId) {
    if (!spatialId || parentNodeId == null) {
        record("crud:spatial-node-lifecycle", false, { reason: "no spatialId/rootNodeId from contract validation" });
        return;
    }
    const nodeUrl = (id) => `${BASE_A}/wow/spatial/${encodeURIComponent(spatialId)}/node/${id}`;
    const probeBody = [{ label: "wowapi-smoke-crud-probe", localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }];

    const created = await probe(nodeUrl(parentNodeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(probeBody),
    });
    const newId = created.body?.[0]?.id;
    record("crud:1-create-post-200-with-assigned-id", created.status === 200 && Number.isInteger(newId), { status: created.status });
    if (!Number.isInteger(newId))
        return;
    try {
        const readBack = await probe(nodeUrl(newId));
        record("crud:2-read-get-matches-created", readBack.status === 200 && readBack.body?.label === "wowapi-smoke-crud-probe", { status: readBack.status });

        const updated = await probe(nodeUrl(newId), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: newId, label: "wowapi-smoke-crud-probe-updated", children: [], localTransform: probeBody[0].localTransform, parent: parentNodeId }),
        });
        record("crud:3-update-put-change-visible", updated.status === 200 && updated.body?.label === "wowapi-smoke-crud-probe-updated", { status: updated.status });
    }
    finally {
        const deleted = await probe(nodeUrl(newId), { method: "DELETE" });
        record("crud:4-delete-succeeds", deleted.status === 200 && !!deleted.body?.ok, { status: deleted.status });
        const gone = await probe(nodeUrl(newId));
        record("crud:5-verify-deletion-404", gone.status === 404, { status: gone.status });
    }
}

// ---- 4b. DELETE /wow/user/{userId} — the spec's other write operation. Exercises both defined
// response cases (400 for the local hosted identity, which has no safe stateless-DELETE
// interpretation) plus a real presence-registry user's full lifecycle: register a throwaway
// player, GET it, DELETE it, confirm it's actually gone (not just "200 and still there"), and
// confirm a second DELETE is idempotent (404, not a false-positive 200).
async function checkDeleteUser() {
    const localDelete = await probe(`${BASE_A}/wow/user/1`, { method: "DELETE" });
    record("crud-user:1-delete-local-identity-400", localDelete.status === 400 && localDelete.body?.error === "invalid_user_value", { status: localDelete.status });

    const unknownDelete = await probe(`${BASE_A}/wow/user/wowapi-smoke-nonexistent-user`, { method: "DELETE" });
    record("crud-user:2-delete-unknown-user-404", unknownDelete.status === 404, { status: unknownDelete.status });

    const registered = await probe(`${BASE_A}/fabric/presence/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: "wowapi-smoke-delete-user-probe", avatar_id: "avatar-smoke-probe", display_name: "Smoke Probe" }),
    });
    const playerId = registered.body?.player?.player_id;
    record("crud-user:3-register-presence-player", registered.status === 201 && !!playerId, { status: registered.status });
    if (registered.status !== 201 || !playerId)
        return;
    try {
        const readBack = await probe(`${BASE_A}/wow/user/${playerId}`);
        const wowUserId = readBack.body?.id;
        record("crud-user:4-read-registered-user", readBack.status === 200 && Number.isInteger(wowUserId), { status: readBack.status });
        if (!Number.isInteger(wowUserId))
            return;

        const deleted = await probe(`${BASE_A}/wow/user/${wowUserId}`, { method: "DELETE" });
        record("crud-user:5-delete-registered-user-200", deleted.status === 200 && deleted.body?.deleted === true, { status: deleted.status });

        const goneRes = await probe(`${BASE_A}/wow/user/${playerId}`);
        record("crud-user:6-verify-deletion-404-not-resurrected", goneRes.status === 404, { status: goneRes.status });

        const secondDelete = await probe(`${BASE_A}/wow/user/${wowUserId}`, { method: "DELETE" });
        record("crud-user:7-second-delete-idempotent-404", secondDelete.status === 404, { status: secondDelete.status });
    }
    finally {
        // Best-effort cleanup in case an assertion above threw before the real delete ran —
        // departing twice is harmless (idempotent), matching check 7's own expectation.
        await probe(`${BASE_A}/fabric/presence/depart`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ player_id: playerId, reason: "wowapi-smoke-cleanup" }),
        }).catch(() => { });
    }
}

// ---- 4c. Request limits. A node body nested deeper than the server's limit (64 levels) is
// refused with 422 before it is walked further, and a body over 1 MB is refused with 413. The
// server must stay healthy after both.
function nestedNodeBody(depth) {
    let node = { label: "wowapi-smoke-depth-probe" };
    for (let level = 0; level < depth; level += 1)
        node = { label: "wowapi-smoke-depth-probe", children: [node] };
    return [node];
}
async function checkRequestLimits(spatialId, parentNodeId) {
    if (!spatialId || parentNodeId == null) {
        record("limits:node-tree-depth-422", false, { reason: "no spatialId/rootNodeId from contract validation" });
        return;
    }
    const nodeUrl = `${BASE_A}/wow/spatial/${encodeURIComponent(spatialId)}/node/${parentNodeId}`;
    const deep = await probe(nodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nestedNodeBody(70)),
    });
    record("limits:node-tree-depth-422", deep.status === 422 && deep.body?.error === "node_tree_too_deep", { status: deep.status, error: deep.body?.error });

    const item = JSON.stringify({ label: "wowapi-smoke-size-probe" });
    const oversized = `[${Array(Math.ceil(1.2e6 / item.length)).fill(item).join(",")}]`;
    let large;
    try {
        large = await probe(nodeUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: oversized });
    }
    catch (error) {
        large = { status: 0, body: { error: String(error.cause?.code || error.message) } };
    }
    record("limits:oversized-body-413", large.status === 413 && large.body?.error === "payload_too_large", { status: large.status, error: large.body?.error, bytes: oversized.length });

    const health = await probe(`${BASE_A}/healthz`);
    record("limits:server-healthy-after", health.status === 200 && health.body?.ok === true, { status: health.status });
}

// ---- 5. Cross-service integration ----
async function checkCrossServiceIntegration(world, openAssetId) {
    if (openAssetId) {
        const asset = await probe(`${BASE_A}/wow/asset/${encodeURIComponent(openAssetId)}`, { headers: { Accept: "model/gltf+json" } });
        record("cross-service:world-to-asset", asset.status === 200 && !!asset.body?.asset, { status: asset.status });
    }
    const portal = await probe(`${BASE_A}/wow/portal/1`);
    const destBase = portal.body?.destination?.target_base_url;
    if (destBase) {
        const destHealth = await probe(`${destBase}/healthz`);
        record("cross-service:portal-to-destination-world-healthy", destHealth.status === 200 && destHealth.body?.ok === true, destHealth.body);
    }
    else {
        record("cross-service:portal-to-destination-world-healthy", false, { reason: "portal 1 has no destination.target_base_url" });
    }
    const manifest = await probe(`${BASE_A}/wow/user/1`);
    const manifestOk = manifest.status === 200 && !!manifest.body?.open_user_manifest?.signature?.value;
    const worldAfter = await probe(`${BASE_A}/wow/world`);
    record("cross-service:manifest-to-world", manifestOk && worldAfter.status === 200, { manifestOk, worldStatus: worldAfter.status });
}

// ---- 6. Search & discovery — not applicable. No search/list endpoints exist in this API surface.

// ---- 7. Error handling ----
async function checkErrorHandling() {
    const unknownPortal = await probe(`${BASE_A}/wow/portal/999`);
    record("errors:unknown-portal-id-404", unknownPortal.status === 404, { status: unknownPortal.status });

    const unknownSpatial = await probe(`${BASE_A}/wow/spatial/${encodeURIComponent("does-not-exist")}`);
    record("errors:unknown-spatial-id-404", unknownSpatial.status === 404, { status: unknownSpatial.status });

    const bareAsset = await probe(`${BASE_A}/wow/asset`);
    record("errors:bare-asset-path-404", bareAsset.status === 404, { status: bareAsset.status });

    // This server answers an unsupported method with 404 rather than a REST-conventional 405 —
    // recorded against the actual observed behavior, not the generic template's assumption.
    const unsupportedVerb = await fetch(`${BASE_A}/wow/world`, { method: "DELETE" });
    record("errors:unsupported-verb-404", unsupportedVerb.status === 404, { status: unsupportedVerb.status });
}

// ---- 8. Data consistency ----
async function checkDataConsistency() {
    const portal = await probe(`${BASE_A}/wow/portal/1`);
    const declaredLocationId = portal.body?.destination?.target_location_id;
    const destBase = portal.body?.destination?.target_base_url;
    if (declaredLocationId && destBase) {
        const destHealth = await probe(`${destBase}/healthz`);
        record("consistency:portal-destination-location-id-matches", destHealth.body?.location_id === declaredLocationId, { declared: declaredLocationId, actual: destHealth.body?.location_id });
    }
    else {
        record("consistency:portal-destination-location-id-matches", false, { reason: "missing destination fields on portal 1" });
    }
    const sharedEdgeCounterpart = portal.body?.webofworlds_extension?.shared_edge?.counterpart?.location_id;
    record("consistency:shared-edge-counterpart-matches-destination", sharedEdgeCounterpart === declaredLocationId, { sharedEdgeCounterpart, declaredLocationId });
}

// ---- 9. Performance smoke — additional thresholds beyond the healthz ones checked in section 1 ----
async function checkPerformance() {
    const t0 = performance.now();
    await probe(`${BASE_A}/wow/world`);
    record("performance:world-get-under-1s", performance.now() - t0 < 1000, { elapsedMs: Math.round(performance.now() - t0) });
}

// ---- 10. End-to-end golden path (pure HTTP — no browser/UI). This demo has no authentication
// step and no generic "update user state over REST" endpoint (state changes go over the
// WebSocket/presence protocol, not a resource write) — recorded honestly as not-applicable rather
// than force-fit, matching section 4's note above. ----
async function checkGoldenPath() {
    const manifest = await probe(`${BASE_A}/wow/user/1`);
    const manifestOk = manifest.status === 200 && !!manifest.body?.open_user_manifest;
    record("golden-path:1-load-user-manifest", manifestOk, { status: manifest.status });

    const world = await probe(`${BASE_A}/wow/world`);
    const portalCount = Number(world.body?.portals?.portal_count) || 0;
    record("golden-path:2-enumerate-accessible-portals", world.status === 200 && portalCount > 0, { portalCount });

    const spatialId = world.body?.id;
    const graph = spatialId ? await probe(`${BASE_A}/wow/spatial/${encodeURIComponent(spatialId)}`) : { status: 0 };
    record("golden-path:3-open-world-retrieve-graph", graph.status === 200, { status: graph.status });

    const { body: scene } = await probe(`${BASE_A}/demo/scene-objects`);
    const openObject = (scene?.objects || [])[2];
    const assetId = openObject ? "primitive-" + openObject.object_id : null;
    const asset = assetId ? await probe(`${BASE_A}/wow/asset/${encodeURIComponent(assetId)}`, { headers: { Accept: "model/gltf+json" } }) : { status: 0 };
    record("golden-path:4-resolve-and-download-referenced-asset", asset.status === 200 && !!asset.body?.asset, { status: asset.status });
}

async function main() {
    run("stopOpenSpatialLab.sh", ["--quiet"]);
    const receipt = run("launchOpenSpatialLab.sh");
    if (!receipt.includes("Open Spatial Lab is ready."))
        throw new Error("startup receipt missing");
    try {
        await checkServiceAvailability();
        const { openAssetId } = await checkAuthAndAuthorization();
        const { world, spatialId, rootNodeId } = await checkContractValidation();
        await checkCrudCoverage(spatialId, rootNodeId);
        await checkDeleteUser();
        await checkRequestLimits(spatialId, rootNodeId);
        await checkCrossServiceIntegration(world, openAssetId);
        await checkErrorHandling();
        await checkDataConsistency();
        await checkPerformance();
        await checkGoldenPath();
    }
    finally {
        run("stopOpenSpatialLab.sh", ["--quiet"]);
    }
    const failed = checks.filter((c) => !c.ok);
    for (const check of checks)
        console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
    console.log(`\n${checks.length - failed.length}/${checks.length} WoWAPI smoke checks passed`);
    if (failed.length) {
        console.error("\nFAILED:");
        for (const check of failed)
            console.error(`  ${check.name}: ${JSON.stringify(check.detail)}`);
        process.exit(1);
    }
    console.log("PASS: WoWAPI smoke suite complete");
}
main().catch((error) => {
    try {
        run("stopOpenSpatialLab.sh", ["--quiet"]);
    }
    catch { }
    console.error(error.stack || error.message);
    process.exit(1);
});
