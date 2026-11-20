// The scene view kit (docs/engine/SCENE-CONTRACT-V0.md, section 12): skins in the Scene, drawn by the Three.js module's
// scene view. The fixture is renderer consumer kit 1.1.2's two-joint skin with its rest and bent completed poses
// (src/fixtures/scene-view-kit/two-joint-skin.json, a byte copy of that kit's fixture.json). Each check has one planted
// fault, run in a copy of the code after the checks pass (tools/behavior/node-checks.mjs).
//   node src/scene-view-kit-check.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";

// The engine's bundled Three.js, as the browser's import map gives it (the renderer check's loader).
register("../tools/renderer/node-fixture-loader.mjs", import.meta.url);
const THREE = await import("three");
const ENGINE = "../runtime/scene-core/public/";
const { OwnX3dRenderAdapter } = await import(`${ENGINE}x3d/own-x3d-render-adapter.mjs`);
const { createScene } = await import(`${ENGINE}scene/scene.mjs`);
const { createSceneView } = await import(`${ENGINE}render/three/scene-view.mjs`);
const { multiplyMat4, transformPoint } = await import(`${ENGINE}core/math.mjs`);

const { check, finish } = nodeChecks("scene-view-kit");
const TYPED = { Float32Array, Uint16Array, Uint8Array };
const decodeTyped = (_key, value) => (value && Object.hasOwn(value, "$typed") ? new TYPED[value.$typed](value.values) : value);
const fixture = JSON.parse(readFileSync(new URL("./fixtures/scene-view-kit/two-joint-skin.json", import.meta.url), "utf8"), decodeTyped);
assert.equal(fixture.schema, "renderer-consumer-fixture/1");
const { descriptor, poses } = fixture;
const BODY = "two-joint";

const IDENTITY = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const GREY = { model: "classic", colorSpace: "linear", diffuseColor: [0.5, 0.5, 0.5], emissiveColor: [0, 0, 0], ambientIntensity: 0.2,
    specularColor: [0, 0, 0], shininess: 0.2, transparency: 0, doubleSided: false };
/** A world layer with one box: the view draws it, and a change to it rebuilds the view. */
const worldLayer = () => ({ kind: "content", source: { uri: "kit:world", format: "kit" }, navigation: null, environment: null,
    entities: [{ id: "floor", name: "floor", parent: null, transform: IDENTITY, components: { mesh: { primitives: [{ geometry: "box", material: "grey" }] } }, source: null, extras: {} }],
    assets: { geometries: { box: { type: "box", size: [4, 0.1, 4] } }, materials: { grey: GREY }, textures: {}, images: {} } });
/** The application's visitors layer: one skinned entity per id, all on the two-joint body. */
const visitorsLayer = (ids, pose = poses.rest) => ({ kind: "content", source: { uri: null, format: "application" }, navigation: null, environment: null,
    entities: ids.map((id) => ({ id, name: id, parent: null, transform: IDENTITY, components: { skin: { body: BODY, pose: structuredClone(pose) } }, source: null, extras: {} })),
    assets: { geometries: {}, materials: {}, textures: {}, images: {}, bodies: { [BODY]: descriptor } } });
const sceneWith = (ids, { pose, visible = true } = {}) => {
    const scene = createScene();
    scene.addLayer(worldLayer(), { name: "world" });
    scene.addLayer(visitorsLayer(ids, pose), { name: "visitors", visible });
    return scene;
};

/** The adapter, with every bindSkin and every disposeSkin it answers recorded per binding. */
function recordedAdapter() {
    const adapter = new OwnX3dRenderAdapter(THREE, {}), bound = [], freed = new Map();
    const bind = adapter.bindSkin.bind(adapter), free = adapter.disposeSkin.bind(adapter);
    adapter.bindSkin = (description) => { const binding = bind(description); bound.push(binding); return binding; };
    adapter.disposeSkin = (binding) => {
        const answer = free(binding), entry = freed.get(binding) ?? { calls: 0, freed: 0 };
        entry.calls += 1; if (answer) entry.freed += 1; freed.set(binding, entry);
        return answer;
    };
    return { adapter, bound, freed };
}

/** The drawn body of an entity, found by its ref under the view's root; null when nothing is drawn for it. */
function drawnBody(view, id) {
    let body = null;
    view.root.traverse((node) => { if (!body && node.userData.ref?.layer === "visitors" && node.userData.ref.id === id) body = node; });
    return body;
}
const skinnedIn = (node) => { const found = []; node.traverse((child) => { if (child.isSkinnedMesh) found.push(child); }); return found; };
/** The drawn body's points in the world, as Three.js skins them. */
function drawnPoints(view, id) {
    const body = drawnBody(view, id);
    assert.ok(body, `nothing is drawn for ${id}`);
    const [mesh] = skinnedIn(body), position = mesh.geometry.attributes.position;
    return Array.from({ length: position.count }, (_, i) => mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(position, i)).applyMatrix4(mesh.matrixWorld).toArray());
}

/**
 * Kit 1.1.2's expectation, computed here without Three.js: linear blend skinning of the fixture's weighted triangle
 * (attached bind mode) under a completed pose. Joint world = rootMatrix, then each local joint matrix down the parents.
 */
function expectedPoints(pose) {
    const mesh = descriptor.resources.meshes[0], skin = mesh.skin, attributes = descriptor.resources.geometries[0].attributes;
    assert.equal(skin.bindMode, "attached");
    const world = {};
    pose.jointIds.forEach((id, i) => { const parent = pose.parentJointIds[i]; world[id] = multiplyMat4(parent ? world[parent] : pose.rootMatrix, pose.jointLocalMatrices[i]); });
    const P = attributes.position.data, J = attributes.skinIndex.data, W = attributes.skinWeight.data;
    return Array.from({ length: P.length / 3 }, (_, v) => {
        const bound = transformPoint(skin.bindMatrix, [P[3 * v], P[3 * v + 1], P[3 * v + 2]]), out = [0, 0, 0];
        for (let k = 0; k < 4; k += 1) {
            const weight = W[4 * v + k];
            if (!weight) continue;
            const palette = J[4 * v + k], point = transformPoint(multiplyMat4(world[skin.jointIds[palette]], skin.inverseBindMatrices[palette]), bound);
            for (let a = 0; a < 3; a += 1) out[a] += weight * point[a];
        }
        return out;
    });
}
const farthest = (a, b) => Math.max(...a.map((point, i) => Math.hypot(...point.map((value, axis) => value - b[i][axis]))));
const edges = (points) => points.flatMap((p, i) => points.slice(i + 1).map((q) => Math.hypot(...p.map((value, axis) => value - q[axis]))));
const EPSILON = 1e-6;

await check("bent-pose", "A pose written to the Scene moves the drawn points as kit 1.1.2 expects, in place", async () => {
    const { adapter, bound } = recordedAdapter(), scene = sceneWith(["a"]), view = createSceneView(adapter, scene);
    const rest = drawnPoints(view, "a");
    assert.ok(farthest(rest, expectedPoints(poses.rest)) < EPSILON, `the rest pose is drawn ${farthest(rest, expectedPoints(poses.rest))} m off`);
    const seen = scene.revision;
    scene.writePose({ layer: "visitors", id: "a" }, poses.bent);
    assert.equal(view.apply(scene.changes(seen)), true, "a pose change rebuilt the view");
    const bent = drawnPoints(view, "a"), off = farthest(bent, expectedPoints(poses.bent));
    assert.ok(off < EPSILON, `the bent pose is drawn ${off} m from kit 1.1.2's skinned points`);
    const stretch = Math.max(...edges(rest).map((length, i) => Math.abs(length - edges(bent)[i])));
    assert.ok(stretch > 0.1, `the bent pose did not bend the triangle (edge change ${stretch})`);
    assert.equal(bound.length, 1, "the body was built again for a pose");
    view.dispose(); adapter.dispose();
});

await check("late-view", "A view started from revision 0 after the bent pose shows the bent pose", async () => {
    const scene = sceneWith(["a"]);
    scene.writePose({ layer: "visitors", id: "a" }, poses.bent);
    for (const label of ["first view", "a renderer swapped in beside it"]) {
        const { adapter } = recordedAdapter(), view = createSceneView(adapter, scene);
        const off = farthest(drawnPoints(view, "a"), expectedPoints(poses.bent));
        assert.ok(off < EPSILON, `the late view (${label}) is drawn ${off} m from the bent pose`);
    }
});

await check("hidden-layer", "A hidden visitors layer draws nothing, and shows the latest pose when shown again", async () => {
    const { adapter, bound, freed } = recordedAdapter(), scene = sceneWith(["a"], { visible: false }), view = createSceneView(adapter, scene);
    assert.equal(drawnBody(view, "a"), null, "the hidden visitors layer is drawn");
    assert.equal(skinnedIn(view.root).length, 0, "the hidden visitors layer draws a skinned mesh");
    assert.equal(bound.length, 0, "a body was built for the hidden visitors layer");
    let seen = scene.revision;
    scene.writePose({ layer: "visitors", id: "a" }, poses.bent);
    scene.setLayerVisible("visitors", true);
    assert.equal(view.apply(scene.changes(seen)), true, "showing the visitors layer rebuilt the view");
    const off = farthest(drawnPoints(view, "a"), expectedPoints(poses.bent));
    assert.ok(off < EPSILON, `shown again, the visitors layer is drawn ${off} m from its latest pose`);
    seen = scene.revision;
    scene.setLayerVisible("visitors", false);
    assert.equal(view.apply(scene.changes(seen)), true, "hiding the visitors layer rebuilt the view");
    assert.equal(drawnBody(view, "a"), null, "the hidden visitors layer is still drawn");
    assert.equal(skinnedIn(view.root).length, 0, "the hidden visitors layer still draws a skinned mesh");
    assert.deepEqual([...freed.values()], [{ calls: 1, freed: 1 }], "hiding did not free the body once");
    view.dispose(); adapter.dispose();
});

await check("freed-once", "A body is freed once when its entity goes, when its layer goes and when the view goes", async () => {
    const { adapter, bound, freed } = recordedAdapter(), scene = sceneWith(["a", "b"]), view = createSceneView(adapter, scene);
    const [a, b] = bound, disposals = new Map();
    for (const binding of bound) binding.root.traverse((node) => {
        for (const resource of [node.geometry, node.material, node.material?.map, node.skeleton].filter(Boolean)) {
            if (disposals.has(resource)) continue;
            disposals.set(resource, 0);
            const count = () => disposals.set(resource, disposals.get(resource) + 1);
            if (resource.addEventListener) resource.addEventListener("dispose", count);
            else { const dispose = resource.dispose.bind(resource); resource.dispose = () => { count(); return dispose(); }; }
        }
    });
    const step = (change) => { const seen = scene.revision; change(); assert.equal(view.apply(scene.changes(seen)), true, "a visitors change rebuilt the view"); };
    step(() => { scene.removeLayer("visitors"); scene.addLayer(visitorsLayer(["a"]), { name: "visitors" }); });
    assert.deepEqual(freed.get(b), { calls: 1, freed: 1 }, "the body of the entity that went was not freed once");
    assert.equal(freed.has(a), false, "the body of the entity that stayed was freed");
    assert.equal(bound.length, 2, "the body of the entity that stayed was built again");
    step(() => scene.removeLayer("visitors"));
    assert.deepEqual(freed.get(a), { calls: 1, freed: 1 }, "the body was not freed once when its layer went");
    step(() => scene.addLayer(visitorsLayer(["c"]), { name: "visitors" }));
    const c = bound[2];
    assert.equal(view.dispose(), true); assert.equal(view.dispose(), false);
    assert.deepEqual(freed.get(c), { calls: 1, freed: 1 }, "the body was not freed once when the view went");
    assert.ok([...freed.values()].every((entry) => entry.calls === 1 && entry.freed === 1), "a body was freed more than once");
    assert.ok(disposals.size > 0 && [...disposals.values()].every((count) => count === 1), "a body's geometry, material, texture or skeleton was not freed exactly once");
    adapter.dispose();
});

await check("write-pose", "scene.writePose records one change of kind pose and keeps a copy of the latest pose", async () => {
    const scene = createScene(), ref = { layer: "visitors", id: "a" };
    scene.addLayer(visitorsLayer(["a"]), { name: "visitors" });
    assert.equal(scene.asset("visitors", "bodies", BODY), descriptor);
    const before = scene.revision, written = structuredClone(poses.bent);
    assert.equal(scene.writePose(ref, written), before + 1);
    assert.deepEqual(scene.changes(before), [{ revision: before + 1, kind: "pose", ref, component: "skin" }], "writePose did not record one change of kind pose");
    assert.deepEqual(scene.get(ref).components.skin.pose, poses.bent);
    written.jointLocalMatrices[1][12] = 99;
    assert.deepEqual(scene.get(ref).components.skin.pose, poses.bent, "the Scene kept the writer's pose object, not a copy");
    assert.ok(Object.isFrozen(scene.get(ref).components.skin.pose.jointLocalMatrices[1]), "the pose in the Scene is not frozen");
    assert.throws(() => scene.writePose(ref, { ...poses.bent, rootMatrix: poses.bent.rootMatrix.slice(1) }), /rootMatrix/);
    scene.addLayer(worldLayer(), { name: "world" });
    assert.throws(() => scene.writePose({ layer: "world", id: "floor" }, poses.bent), /no skin/);
    const missing = visitorsLayer(["a"]); missing.assets.bodies = {};
    assert.throws(() => scene.addLayer(missing, { name: "others" }), /missing bodies entry/);
    assert.equal(scene.revision, before + 2, "a refused write changed the Scene");
});

await check("swap-visitor", "A renderer attached to a Scene that already has a visitor draws exactly one live skin, and still one after a full rebuild", async () => {
    const { adapter, bound, freed } = recordedAdapter(), scene = sceneWith(["a"]);
    const live = () => bound.filter((binding) => !freed.get(binding)?.freed);
    const oneLiveSkinDrawn = (label) => {
        const view = adapter._view, body = view && drawnBody(view, "a");
        assert.ok(body, `${label}: nothing is drawn for the visitor`);
        assert.equal(live().length, 1, `${label}: ${live().length} live skins, not exactly one`);
        assert.equal(adapter._skins.size, 1, `${label}: the adapter holds ${adapter._skins.size} skins, not exactly one`);
        const [binding] = live(), drawn = skinnedIn(view.root);
        assert.ok(drawn.length > 0 && drawn.every((mesh) => skinnedIn(binding.root).includes(mesh)), `${label}: the drawn skinned meshes are not the live skin's`);
    };
    adapter.attachScene(scene);
    adapter.syncScene();
    oneLiveSkinDrawn("attached mid-visit");
    scene.addLayer(worldLayer(), { name: "world-2" });
    adapter.syncScene();
    assert.equal(bound.length, 2, "the full rebuild did not build the body again");
    oneLiveSkinDrawn("after a full rebuild");
    adapter.dispose();
});

const VIEW = "runtime/scene-core/public/render/three/scene-view.mjs", SCENE = "runtime/scene-core/public/scene/scene.mjs";
const fault = (statement, name, file, find, replace, expect) => ({ statement, name, expect, edits: [{ file, find, replace }] });
await finish({ checkFile: "src/scene-view-kit-check.mjs", faults: [
    fault("bent-pose", "a written pose is not applied", VIEW, "adapter.setSkinPose(body.binding, scene.get(ref).components.skin.pose);", "void body;", /bent pose is drawn/),
    fault("late-view", "a new body is drawn in its bind pose, not its latest pose", VIEW, "adapter.setSkinPose(binding, entity.components.skin.pose);", "void entity;", /late view/),
    fault("hidden-layer", "mover layers are drawn whether shown or hidden", VIEW, "const shownMovers = () => shown().filter(isMoverLayer);", "const shownMovers = () => scene.layers().filter(isMoverLayer);", /hidden visitors layer is drawn/),
    fault("freed-once", "the body of an entity that goes is dropped, not freed", VIEW, "if (!keep) freeBody(body);", "if (!keep) bodies.delete(key(body.ref));", /entity that went was not freed once/),
    fault("write-pose", "writePose records an entity change", SCENE, `return record("pose", { layer: ref.layer, id: entity.id }, "skin");`, `return record("entity", { layer: ref.layer, id: entity.id }, "skin");`, /kind pose/),
    fault("swap-visitor", "the rebuild retires the skins the new view just bound", "runtime/scene-core/public/x3d/own-x3d-render-adapter.mjs", "...skins.map((skin) => () => this.disposeSkin(skin)),", "...[...this._skins].map((skin) => () => this.disposeSkin(skin)),", /live skins, not exactly one|nothing is drawn for the visitor|not the live skin's/),
] });
