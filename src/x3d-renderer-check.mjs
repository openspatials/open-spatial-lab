import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import * as THREE from "three";
import { OwnX3dRenderAdapter } from "../runtime/scene-core/public/x3d/own-x3d-render-adapter.mjs";
import { documentToLayer, x3dImporter } from "../runtime/scene-core/public/import/x3d/to-scene.mjs";
import { createSceneHost } from "../runtime/scene-core/public/scene/manager.mjs";
import { isX3dDocument, parseX3dDocument } from "../runtime/scene-core/public/x3d/json-document.mjs";
import { SOFT_BODY_COMPATIBILITY } from "../runtime/scene-core/public/x3d/profile.mjs";
import { prepareWorld } from "../web/soft-body-world.mjs";

const fixtureIndex = process.argv.indexOf("--fixture");
assert.ok(fixtureIndex >= 0 && process.argv[fixtureIndex + 1], "Supply --fixture <accepted fixture.json>");
const fixtureURL = pathToFileURL(resolve(process.argv[fixtureIndex + 1]));
const { decodeTyped } = await import(new URL("./fixture-source.mjs", fixtureURL));
const fixture = JSON.parse(await readFile(fixtureURL, "utf8"), decodeTyped);
assert.equal(fixture.schema, "renderer-consumer-fixture/1");
assert.equal(THREE.REVISION, "186");
const anchorText = await readFile(new URL("../web/x3d-worlds/anchor-portal-world.x3d.json", import.meta.url), "utf8");
const softText = await readFile(new URL("../web/x3d-worlds/soft-body.x3d.json", import.meta.url), "utf8");
const anchor = await parseX3dDocument(anchorText);
const soft = await parseX3dDocument(softText, { compatibility: SOFT_BODY_COMPATIBILITY });
const bound = { portalBindings: [{ sensor: "PortalTrigger", anchor: "PortalAnchor" }] };
const near = (a, b, epsilon = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${a} != ${b}`)); };
// This measures layout/ownership only; these canvas doubles do not rasterize glyphs.
const canvases = [];
function createCanvas() {
    const calls = [], context = { measureText: (s) => ({ width: s.length * 32 }), clearRect() {}, fillText: (...args) => calls.push(args) };
    const canvas = { width: 0, height: 0, calls, getContext: () => context }; canvases.push(canvas); return canvas;
}
const make = () => new OwnX3dRenderAdapter(THREE, { createCanvas, preparePhysics: prepareWorld });
// The Scene Manager's document host with the X3D importer: import, then scene.addLayer, then renderer.syncScene;
// Interaction and the physics sink on that Scene. load takes X3D text or a read document, as the document route does.
const documentsOf = (renderer) => {
    const host = createSceneHost({ renderer });
    return Object.freeze({
        get state() { return host.state; },
        load(input, { compatibility, portalBindings = [], signal } = {}) {
            const read = isX3dDocument(input) ? input : null;
            const importer = read ? { ...x3dImporter, import: async (_source, { options }) => documentToLayer(read, { name: options.name, preparePhysics: options.preparePhysics }) } : x3dImporter;
            return host.load({ text: read ? null : input }, { importer, signal, centerOf: (entity) => entity.extras.x3d.centerOfRotation,
                options: { compatibility, preparePhysics: prepareWorld, portalBindings } });
        },
        cancel: host.cancel, step: host.step, activate: host.activate, pick: host.pick, dispose: host.dispose,
    });
};
class RendererDouble {
    constructor() { this.domElement = {}; this.disposals = 0; }
    getContext() { return {}; }
    setPixelRatio() {} setSize() {}
    dispose() { this.disposals++; if (this.disposalError) throw this.disposalError; }
}
const host = { clientWidth: 800, clientHeight: 400, appendChild(canvas) { canvas.parentNode = this; }, removeChild(canvas) { canvas.parentNode = null; } };
const byDef = (state, def) => state.realization.objects.get(`DEF:${def}`)[0];
function observeDisposal(root) {
    const resources = new Map();
    const add = (resource) => {
        if (!resource || resources.has(resource)) return;
        resources.set(resource, 0);
        const count = () => resources.set(resource, resources.get(resource) + 1);
        if (resource.addEventListener) resource.addEventListener("dispose", count);
        else { const dispose = resource.dispose.bind(resource); resource.dispose = () => { count(); return dispose(); }; }
    };
    root.traverse((object) => {
        add(object.geometry); add(object.skeleton);
        for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
            add(material); for (const value of Object.values(material)) if (value?.isTexture) add(value);
        }
    });
    return () => { assert.ok(resources.size > 0); assert.ok([...resources.values()].every((n) => n === 1), "each resource disposed exactly once"); };
}
let cases = 0, rafCalls = 0;
const originalRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = () => { rafCalls++; throw new Error("Unexpected internal RAF"); };
async function check(name, run) { await run(); cases++; console.log(`PASS ${name}`); }
try {
    await check("authored portal geometry, linear materials, text, lights, camera and background", async () => {
        const adapter = make(), state = await documentsOf(adapter).load(anchor);
        near(state.camera.position.toArray(), [0, 1.6, 6]); near([state.camera.fov], [0.9 * 180 / Math.PI]);
        near(state.realization.scene.background.toArray(), [0.09, 0.13, 0.22]);
        const floor = byDef(state, "Floor").children[0];
        assert.equal(floor.geometry.parameters.width, 14); near(floor.material.color.toArray(), [0.11, 0.32, 0.5]);
        const disc = byDef(state, "PortalDisc").children[0];
        assert.equal(disc.geometry.parameters.radiusTop, 1.1); near(disc.material.emissive.toArray(), [0.55, 0.26, 0.12]);
        const label = byDef(state, "PortalLabel").children[0];
        assert.deepEqual(label.userData.text, { lines: ["Location B"], size: 0.35, justify: ["MIDDLE", "MIDDLE"], baselineApproximation: "serif canvas at 64 pixels per em" });
        assert.equal(label.material.map, label.material.emissiveMap); assert.equal(label.material.alphaTest, 0.01);
        label.geometry.computeBoundingBox(); near(label.geometry.boundingBox.getCenter(new THREE.Vector3()).toArray(), [0, 0, 0]);
        near([label.geometry.parameters.height], [(64 + 16) * 0.35 / 64]);
        assert.ok(canvases.some((c) => c.calls.some(([s]) => s === "Location B")));
        const lights = state.realization.scene.children.filter((o) => o.isLight);
        assert.deepEqual(lights.map((o) => o.intensity), [0.9, 0.5]); near(lights[0].target.position.toArray(), [-0.4, -1, -0.6]);
        const shader = { uniforms: {}, fragmentShader: "#include <lights_fragment_begin>" }; floor.material.onBeforeCompile(shader);
        assert.equal(shader.uniforms.x3dAmbientIntensity.value, 1); assert.ok(shader.fragmentShader.includes("getAmbientLightIrradiance( ambientLightColor ) * x3dAmbientIntensity"));
        const disposed = observeDisposal(state.realization.scene); adapter.dispose(); adapter.dispose(); disposed();
    });
    await check("stable ray node/Anchor identity, host policy and semantic stepping", async () => {
        const adapter = make(), documents = documentsOf(adapter), state = await documents.load(anchor, bound);
        const ray = { origin: [0, 1.2, 6], direction: [0, 0, -1], allowedIds: ["DEF:PortalAnchor"] };
        assert.equal(documents.pick({ ...ray, allowedIds: [] }), null);
        const hit = documents.pick(ray); assert.equal(hit.anchorId, "DEF:PortalAnchor"); assert.equal(hit.type, "Shape"); assert.equal(hit.frame, "world");
        assert.ok(hit.distance > 8 && hit.distance < 9); assert.equal(documents.pick(ray).instance, hit.instance);
        byDef(state, "PortalAnchor").visible = false; assert.equal(documents.pick(ray), null); byDef(state, "PortalAnchor").visible = true;
        assert.throws(() => documents.pick({ ...ray, allowedIds: new Array(1) }), /ray.allowedIds/);
        assert.equal(documents.activate("PortalAnchor", { time: 0 }), null);
        assert.equal(documents.step({ time: 1, position: [0, 1.2, -2.5], allowedAnchors: ["PortalAnchor"] }).intents[0].urls[0], "/w/b/");
        const intent = documents.activate("PortalAnchor", { time: 2, allowedAnchors: ["PortalAnchor"] }); documents.cancel(); assert.equal(state.runtime.isCurrent(intent.generation), false);
        adapter.dispose(); assert.throws(() => documents.step({ time: 3, position: [0, 0, 0] }), /live/);
    });
    await check("transformed viewpoint and distinct USE placements/resources", async () => {
        const document = await parseX3dDocument(JSON.stringify({ X3D: { "@version": "4.0", "@profile": "Interactive", Scene: { "-children": [
            { Transform: { "@translation": [10, 0, 0], "@rotation": [0, 0, 1, Math.PI / 2], "-children": [
                { Viewpoint: { "@position": [2, 0, 0] } }, { Shape: { "@DEF": "Shared", "-geometry": { Box: {} } } },
            ] } }, { Transform: { "@translation": [-2, 0, 0], "-children": [{ Shape: { "@USE": "Shared" } }] } },
        ] } } }));
        const adapter = make(), state = await documentsOf(adapter).load(document), placements = state.realization.objects.get("DEF:Shared");
        near(state.camera.position.toArray(), [10, 2, 0]); near(new THREE.Vector3(1, 0, 0).applyQuaternion(state.camera.quaternion).toArray(), [0, 1, 0]);
        assert.equal(placements.length, 2); assert.notEqual(placements[0].geometry, placements[1].geometry);
        near(placements[0].getWorldPosition(new THREE.Vector3()).toArray(), [10, 0, 0]); near(placements[1].getWorldPosition(new THREE.Vector3()).toArray(), [-2, 0, 0]); adapter.dispose();
    });
    await check("real soft world retains 41 rigid/two soft bodies; sink changes geometry, normals and bounds", async () => {
        const adapter = make(), documents = documentsOf(adapter), state = await documents.load(soft), realized = state.realization;
        assert.equal(realized.preparedPhysics.rigid.length, 41); assert.equal(realized.preparedPhysics.soft.length, 2);
        near(state.camera.position.toArray(), [-10, 1.6, 10]);
        for (const body of realized.preparedPhysics.rigid) assert.ok(byDef(state, body.def).children[0].isMesh);
        for (const body of realized.preparedPhysics.soft) {
            const mesh = byDef(state, body.def), geometry = mesh.geometry;
            const before = Array.from(geometry.attributes.position.array), normals = Array.from(geometry.attributes.normal.array);
            const changed = before.map((v, i) => i === 0 ? v + 0.5 : i % 3 === 1 ? v + 2 + (i === 1 ? 1 : 0) : v);
            const oldMax = geometry.boundingBox.max.y, version = geometry.attributes.position.version;
            realized.sink.setPoints(body.def, changed); adapter.syncScene();
            assert.equal(geometry.attributes.position.version, version + 1); assert.ok(geometry.boundingBox.max.y >= oldMax + 1.9);
            assert.notDeepEqual(Array.from(geometry.attributes.normal.array), normals); assert.ok(Number.isFinite(geometry.boundingSphere.radius));
            near(realized.sink.readPoints(body.def).flat(), changed, 1e-5);
            assert.throws(() => realized.sink.setPoints(body.def, changed.slice(1)), /count/);
            assert.throws(() => realized.sink.setPoints(body.def, new Array(changed.length)), /soft.points/);
            near(realized.sink.readPoints(body.def).flat(), changed, 1e-5);
        }
        const first = realized.preparedPhysics.rigid[0].def;
        realized.sink.setPose(first, [1, 2, 3], [0, 1, 0, Math.PI / 2]); adapter.syncScene(); near(byDef(state, first).position.toArray(), [1, 2, 3]);
        const done = observeDisposal(realized.scene); adapter.dispose(); documents.dispose(); done(); assert.throws(() => realized.sink.readPoints("Cloth"), /disposed/);
    });
    await check("independent loads, replacement, rejected loads, cancellation and abort", async () => {
        const a = make(), b = make(), A = documentsOf(a), B = documentsOf(b), old = await A.load(anchor), other = await B.load(anchor);
        assert.notEqual(byDef(old, "Floor").children[0].material, byDef(other, "Floor").children[0].material);
        const done = observeDisposal(old.realization.scene); await A.load(soft); done();
        const current = A.state; await assert.rejects(A.load("{}")); assert.equal(A.state, current);
        const pending = A.load(anchorText); A.cancel(); await assert.rejects(pending, { name: "AbortError" }); assert.equal(A.state, current);
        const superseded = A.load(anchorText); const newest = await A.load(soft); await assert.rejects(superseded, { name: "AbortError" }); assert.equal(A.state, newest);
        await assert.rejects(A.load(anchor, { signal: AbortSignal.abort() }), { name: "AbortError" });
        a.dispose(); assert.equal(byDef(other, "Floor").children[0].material.color.b, 0.5); b.dispose();
        await assert.rejects(A.load(anchor), /disposed/);
    });
    await check("construction failure rolls back allocated resources and preserves prior scene", async () => {
        const adapter = make(), documents = documentsOf(adapter), old = await documents.load(anchor), geometries = [];
        const create = adapter.createGeometry.bind(adapter); adapter.createGeometry = (desc) => {
            const geometry = create(desc), count = { n: 0 }; geometry.addEventListener("dispose", () => count.n++); geometries.push(count); return geometry;
        };
        adapter._sceneOptions.createCanvas = () => { throw new Error("canvas failure"); };
        await assert.rejects(documents.load(anchor), /canvas failure/); assert.equal(documents.state, old);
        assert.equal(geometries.length, 5); assert.ok(geometries.every((g) => g.n === 1));
        assert.throws(() => documentToLayer({ ...anchor }), /validated/);
        const unsupported = await parseX3dDocument(JSON.stringify({ X3D: { "@version": "4.0", "@profile": "Interactive", Scene: { "-children": [{ Shape: { "-geometry": { ElevationGrid: {} } } }] } } }));
        await assert.rejects(documents.load(unsupported), /soft-body topology/); adapter.dispose();
    });
    await check("explicit fixture weighted skin, materials, texture, equipment and disposal", async () => {
        const adapter = make(); await documentsOf(adapter).load(anchor);
        assert.throws(() => adapter.bindSkin({ source: new THREE.Group() }), /explicit/);
        assert.throws(() => adapter.createInlineAsset(), /unsupported/);
        const skin = adapter.bindSkin(fixture.descriptor), second = adapter.bindSkin(fixture.descriptor), mesh = skin.meshes[0];
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        assert.equal(material.roughness, 0.6); assert.equal(material.metalness, 0.2); assert.equal(material.side, THREE.DoubleSide); assert.equal(material.transparent, true); assert.equal(material.vertexColors, true);
        assert.equal(material.map.colorSpace, THREE.SRGBColorSpace); assert.deepEqual([...material.map.image.data], [230, 40, 90, 180]);
        assert.notEqual(mesh.geometry, second.meshes[0].geometry); assert.equal(mesh.geometry.attributes.color.normalized, true);
        const vertices = () => Array.from({ length: 3 }, (_, i) => mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i)).applyMatrix4(mesh.matrixWorld).toArray());
        adapter.setSkinPose(skin, fixture.poses.rest); const rest = vertices();
        [[3.25, 2, -4], [3.25, 4, -4], [4.25, 4, -4]].forEach((expected, i) => near(rest[i], expected));
        adapter.setSkinPose(skin, fixture.poses.bent); const bent = vertices();
        [[3.25, 2, -4], [2.5, 3.75, -4], [2.9375, 4.5625, -4]].forEach((expected, i) => near(bent[i], expected));
        assert.ok(new THREE.Vector3(...rest[2]).distanceTo(new THREE.Vector3(...bent[2])) > 1);
        const item = skin.items.get("probe-item"); assert.equal(item.visible, true); near(item.getWorldPosition(new THREE.Vector3()).toArray(), [2.9, 3.7, -3.7]);
        const done = observeDisposal(skin.root), doneSecond = observeDisposal(second.root);
        adapter.disposeSkin(skin); adapter.disposeSkin(skin); done(); adapter.dispose(); doneSecond();
    });
    await check("throwing disposal still releases other scene resources and clears live document", async () => {
        const adapter = make(), documents = documentsOf(adapter), state = await documents.load(anchor), done = observeDisposal(state.realization.scene);
        byDef(state, "Floor").children[0].geometry.addEventListener("dispose", () => { throw new Error("injected dispose failure"); });
        await assert.rejects(documents.load(soft), /failed to dispose/); done();
        assert.equal(documents.state, null); assert.throws(() => documents.step({ time: 0, position: [0, 0, 0] }), /live/);
        await documents.load(anchor); adapter.dispose();
    });
    await check("mount forces host cadence even when frameLoop true is requested", async () => {
        const adapter = new OwnX3dRenderAdapter({ ...THREE, WebGLRenderer: RendererDouble }, { createCanvas, preparePhysics: prepareWorld });
        const documents = documentsOf(adapter), preloaded = await documents.load(anchor); adapter.mount(host, { frameLoop: true }); assert.equal(preloaded.camera.aspect, 2);
        const state = await documents.load(anchor); assert.equal(state.camera.aspect, 2);
        assert.equal(adapter.getCapabilities().engine, "own-x3d"); assert.equal(adapter.getCapabilities().features.portalPreview.status, "limited");
        const renderer = adapter._renderer; adapter.dispose(); assert.equal(renderer.disposals, 1); assert.equal(rafCalls, 0);
    });
    await check("mounted preview failure cannot prevent remaining resources, renderer or canvas retirement", async () => {
        for (const replacement of [false, true]) {
            const adapter = new OwnX3dRenderAdapter({ ...THREE, WebGLRenderer: RendererDouble }, { createCanvas, preparePhysics: prepareWorld });
            adapter.mount(host); const documents = documentsOf(adapter), state = await documents.load(anchor), sceneDone = observeDisposal(state.realization.scene);
            const first = adapter.createRenderedTexture(), remaining = adapter.createRenderedTexture(), renderer = adapter._renderer;
            adapter.bindRenderedTextureScene(first, state.realization.scene, state.camera);
            let firstDisposed = 0, remainingDisposed = 0;
            first.target.addEventListener("dispose", () => { firstDisposed++; throw new Error("injected target listener failure"); });
            remaining.target.addEventListener("dispose", () => { remainingDisposed++; });
            const skin = adapter.bindSkin(fixture.descriptor), skinDone = observeDisposal(skin.root);
            if (replacement) {
                await assert.rejects(documents.load(soft), (error) => error instanceof AggregateError && error.errors.some((e) => /target listener/.test(e.message)));
                assert.equal(renderer.disposals, 0); assert.equal(renderer.domElement.parentNode, host);
                assert.equal(adapter._disposed, false); assert.equal(documents.state, null);
            } else {
                renderer.disposalError = new Error("injected renderer disposal failure");
                assert.throws(() => adapter.dispose(), (error) => error instanceof AggregateError && error.errors.length === 2);
                assert.equal(renderer.disposals, 1); assert.equal(renderer.domElement.parentNode, null);
                assert.equal(adapter._renderer, null); assert.equal(adapter._disposed, true);
            }
            assert.equal(firstDisposed, 1); assert.equal(remainingDisposed, 1); sceneDone(); skinDone();
            assert.equal(first.scene, null); assert.equal(first.camera, null);
            assert.equal(adapter._previews.size, 0); assert.equal(adapter._skins.size, 0);
            documents.dispose();
            assert.throws(() => state.runtime.step({ time: 0, position: [0, 0, 0] }), /disposed/);
            assert.throws(() => state.realization.sink.readPoints("none"), /disposed/);
            adapter.dispose(); adapter.dispose(); assert.equal(renderer.disposals, 1); assert.equal(renderer.domElement.parentNode, null);
        }
    });
    await check("disposal releases an owned environment once, with or without the instance dispose wrapper", async () => {
        const adapterURL = new URL("../runtime/scene-core/public/x3d/own-x3d-render-adapter.mjs", import.meta.url);
        const environmentDisposals = async (Adapter, { keepWrapper }) => {
            const adapter = new Adapter(THREE, { createCanvas, preparePhysics: prepareWorld });
            await documentsOf(adapter).load(anchor);
            let resolved = 0;
            const map = () => ({ kind: "equirect-linear-rgb", width: 4, height: 2, data: new Float32Array(4 * 2 * 3).fill(0.5) });
            assert.deepEqual(adapter.setEnvironmentResolver(async (asset, { signal }) => { resolved++; assert.equal(signal.aborted, false); return map(); }), { supported: true, resolver: true });
            const lighting = adapter.setLighting({ environment: { asset: "env://release/uniform.rgb", intensity: 1 } });
            assert.equal(lighting.environmentStatus, "loading");
            assert.equal((await lighting.environmentReady).status, "applied");
            const texture = adapter.sceneRoot.environment;
            assert.ok(texture?.isDataTexture); assert.equal(texture.type, THREE.FloatType); assert.equal(resolved, 1);
            let count = 0; texture.addEventListener("dispose", () => count++);
            const wrapped = Object.hasOwn(adapter, "dispose");
            if (!keepWrapper) delete adapter.dispose;
            const viaWrapper = Object.hasOwn(adapter, "dispose");
            assert.equal(viaWrapper, keepWrapper && wrapped);
            adapter.dispose(); const first = count;
            adapter.dispose();
            return { wrapped, viaWrapper, first, second: count, cleared: adapter.sceneRoot.environment === null, owned: adapter._environment.owned };
        };
        const releasedOnce = ({ first, second, cleared, owned }) => assert.deepEqual({ first, second, cleared, owned }, { first: 1, second: 1, cleared: true, owned: null });
        const wrapped = await environmentDisposals(OwnX3dRenderAdapter, { keepWrapper: true });
        const unwrapped = await environmentDisposals(OwnX3dRenderAdapter, { keepWrapper: false });
        releasedOnce(wrapped); releasedOnce(unwrapped);
        // Planted control: the same adapter source without its environment release entry.
        const source = await readFile(adapterURL, "utf8"), entry = "            () => releaseThreeEnvironment(this),\n";
        assert.ok(source.includes(entry), "environment release entry present in the adapter source");
        const planted = source.replace(entry, "").replace(/from "(\.{1,2}\/[^"]+)"/g, (_, specifier) => `from "${new URL(specifier, adapterURL).href}"`);
        assert.ok(!planted.includes("() => releaseThreeEnvironment(this)") && !/from "\./.test(planted));
        const { OwnX3dRenderAdapter: PlantedAdapter } = await import(`data:text/javascript,${encodeURIComponent(planted)}`);
        const plantedWrapped = await environmentDisposals(PlantedAdapter, { keepWrapper: true });
        const plantedUnwrapped = await environmentDisposals(PlantedAdapter, { keepWrapper: false });
        if (plantedWrapped.wrapped) releasedOnce(plantedWrapped);
        else assert.throws(() => releasedOnce(plantedWrapped), assert.AssertionError, "without a wrapper the planted removal must leak");
        assert.throws(() => releasedOnce(plantedUnwrapped), assert.AssertionError, "planted removal must leak the environment without the wrapper");
        const report = (r) => `wrapper installed ${r.wrapped}, dispose called through wrapper ${r.viaWrapper}, disposals after first/second dispose ${r.first}/${r.second}`;
        console.log(`  environment release: wrapped (${report(wrapped)}); wrapper removed (${report(unwrapped)}); planted removal, wrapper removed (${report(plantedUnwrapped)})`);
    });
} finally {
    if (originalRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = originalRaf;
}
console.log(`X3D renderer checks: ${cases} passed (Three r${THREE.REVISION}; CPU graph/skin, canvas and WebGL lifecycle doubles; no pixel qualification)`);
