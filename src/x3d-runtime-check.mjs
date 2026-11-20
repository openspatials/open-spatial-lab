import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseX3dDocument } from "../runtime/scene-core/public/x3d/json-document.mjs";
import { createLayerRuntime } from "../runtime/scene-core/public/x3d/scene-runtime.mjs";
import { createScene } from "../runtime/scene-core/public/scene/scene.mjs";
import { documentToLayer } from "../runtime/scene-core/public/import/x3d/to-scene.mjs";
import { SOFT_BODY_COMPATIBILITY } from "../runtime/scene-core/public/x3d/profile.mjs";

const anchorText = await readFile(new URL("../web/x3d-worlds/anchor-portal-world.x3d.json", import.meta.url), "utf8");
const softText = await readFile(new URL("../web/x3d-worlds/soft-body.x3d.json", import.meta.url), "utf8");
const anchorDocument = await parseX3dDocument(anchorText);
const bound = { portalBindings: [{ sensor: "PortalTrigger", anchor: "PortalAnchor" }] };
const allowed = { allowedAnchors: ["PortalAnchor"] };
const frame = (time, position, extra = {}) => ({ time, position, ...allowed, ...extra });
const fieldEvents = (result, field) => result.events.filter((e) => e.field === field);
const near = (actual, expected) => { assert.equal(actual.length, expected.length); actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-8, `${actual} != ${expected}`)); };
let cases = 0;
// The X3D importer's layer in a new Scene, with the Scene Manager's Interaction on it (createLayerRuntime).
function createRuntime(document, { portalBindings = [] } = {}) {
    const scene = createScene();
    scene.addLayer(documentToLayer(document).layer, { name: "world" });
    return createLayerRuntime(scene, { portalBindings, navigation: document.nodes.filter((n) => n.type === "NavigationInfo").map((n) => n.fields),
        centerOf: (entity) => entity.extras.x3d.centerOfRotation });
}
async function check(name, run) { await run(); cases++; console.log(`PASS ${name}`); }

await check("real entry viewpoint, initial inside, dwell and exit", () => {
    const runtime = createRuntime(anchorDocument, bound);
    near(runtime.viewpoints[0].position, [0, 1.6, 6]);
    assert.equal(runtime.navigation[0].speed, 2);
    const initial = runtime.step(frame(10, [0, 1.2, -2.5]));
    assert.deepEqual(fieldEvents(initial, "isActive").map((e) => e.value), [true]);
    assert.equal(fieldEvents(initial, "enterTime")[0].value, 10);
    assert.equal(initial.intents.length, 1);
    assert.deepEqual(initial.intents[0].urls, ["/w/b/"]);
    assert.deepEqual(initial.intents[0].parameters, ["target=_self"]);
    assert.equal(initial.intents[0].metadata.fields.name, "wow:portal");
    assert.equal(runtime.step(frame(11, [0, 1.2, -2.5])).events.length, 0);
    const move = runtime.step(frame(12, [0.2, 1.2, -2.5]));
    assert.equal(fieldEvents(move, "position_changed").length, 1);
    assert.equal(move.intents.length, 0);
    const exit = runtime.step(frame(13, [2.2, 1.2, -2.5]));
    assert.deepEqual(fieldEvents(exit, "isActive").map((e) => e.value), [false]);
    assert.ok(Math.abs(fieldEvents(exit, "exitTime")[0].value - 12.5) < 1e-9);
    runtime.dispose();
});

await check("swept crossing emits exact boundary times and permits later entry", () => {
    const runtime = createRuntime(anchorDocument, bound);
    runtime.step(frame(0, [-3, 1.2, -2.5]));
    const result = runtime.step(frame(10, [3, 1.2, -2.5]));
    assert.deepEqual(fieldEvents(result, "isActive").map((e) => e.value), [true, false]);
    near([fieldEvents(result, "enterTime")[0].value, fieldEvents(result, "exitTime")[0].value], [3, 7]);
    near(fieldEvents(result, "position_changed")[0].value, [-1.2, 1.2, -2.5]);
    assert.equal(result.intents.length, 1);
    assert.equal(runtime.step(frame(20, [-3, 1.2, -2.5])).intents.length, 1);
    const miss = runtime.step(frame(30, [3, 8, -2.5]));
    assert.equal(miss.intents.length, 0);
});

await check("parent rotation/translation, local sensor coordinates and viewpoint", async () => {
    const document = await parseX3dDocument(JSON.stringify({ X3D: { "@version": "4.0", "@profile": "Interactive", Scene: { "-children": [
        { Transform: { "@translation": [10, 0, 0], "@rotation": [0, 0, 1, Math.PI / 2], "-children": [
            { ProximitySensor: { "@DEF": "S", "@size": [4, 2, 2] } },
            { Viewpoint: { "@position": [2, 0, 0], "@centerOfRotation": [1, 0, 0] } },
        ] } },
    ] } } }));
    const runtime = createRuntime(document);
    near(runtime.viewpoints[0].position, [10, 2, 0]);
    near(runtime.viewpoints[0].centerOfRotation, [10, 1, 0]);
    near(runtime.viewpoints[0].orientation, [0, 0, 1, Math.PI / 2]);
    const result = runtime.step({ time: 1, position: [10, 1, 0], orientation: [0, 0, 1, Math.PI / 2] });
    near(fieldEvents(result, "position_changed")[0].value, [1, 0, 0]);
    near(fieldEvents(result, "orientation_changed")[0].value, [0, 0, 1, 0]);
    const matrix = runtime.matrixOf("0"); matrix[12] = 999;
    assert.equal(runtime.matrixOf("0")[12], 10);
});

await check("disabled and zero-volume sensors, enabled transition, explicit binding", async () => {
    const runtime = createRuntime(anchorDocument, bound);
    assert.equal(runtime.step(frame(0, [0, 1.2, -2.5], { sensorEnabled: { PortalTrigger: false } })).events.length, 0);
    assert.equal(runtime.step(frame(1, [0, 1.2, -2.5], { sensorEnabled: { PortalTrigger: true } })).intents.length, 1);
    assert.deepEqual(fieldEvents(runtime.step(frame(2, [0, 1.2, -2.5], { sensorEnabled: { PortalTrigger: false } })), "isActive").map((e) => e.value), [false]);
    const source = JSON.parse(anchorText);
    source.X3D.Scene["-children"].find((n) => n.ProximitySensor).ProximitySensor["@size"] = [0, 3, 1.2];
    const zero = createRuntime(await parseX3dDocument(JSON.stringify(source)), bound);
    assert.equal(zero.step(frame(0, [0, 1.2, -2.5])).events.length, 0);
    const unbound = createRuntime(anchorDocument);
    const sensed = unbound.step(frame(0, [0, 1.2, -2.5]));
    assert.equal(fieldEvents(sensed, "isActive").length, 1);
    assert.equal(sensed.intents.length, 0);
});

await check("activation and proximity require explicit visible/access allowlist", () => {
    const runtime = createRuntime(anchorDocument, bound);
    assert.equal(runtime.activate("PortalAnchor", { time: 0 }), null);
    assert.equal(runtime.step(frame(0, [0, 1.2, -2.5], { allowedAnchors: [] })).intents.length, 0);
    const picked = runtime.activate("PortalAnchor", { time: 1, ...allowed });
    assert.equal(picked.via, "activate");
    assert.deepEqual(picked.urls, ["/w/b/"]);
    assert.equal(runtime.activate("PortalAnchor", { time: 2, ...allowed }).sequence, picked.sequence + 1);
    assert.throws(() => runtime.activate("PortalAnchor", { time: 1, ...allowed }), /monotonic/);
    assert.throws(() => runtime.step(frame(1, [0, 1.2, -2.5])), /monotonic/);
    assert.throws(() => runtime.activate("Missing", { time: 2, ...allowed }), /unknown Anchor/);
    assert.throws(() => runtime.step(frame(3, [0, 1, 0], { allowedAnchors: ["Missing"] })), /allowedAnchors/);
    assert.throws(() => { picked.urls[0] = "https://invalid.example"; }, TypeError);
});

await check("cancel invalidates held intents, disposal is terminal and instances are independent", () => {
    const a = createRuntime(anchorDocument, bound), b = createRuntime(anchorDocument, bound);
    const held = a.step(frame(0, [0, 1.2, -2.5])).intents[0];
    assert.equal(a.isCurrent(held.generation), true);
    a.cancel();
    assert.equal(a.isCurrent(held.generation), false);
    assert.equal(b.step(frame(0, [0, 1.2, -2.5])).intents.length, 1);
    assert.equal(a.step(frame(0, [0, 1.2, -2.5])).intents.length, 1);
    assert.equal(a.dispose(), true);
    assert.equal(a.dispose(), false);
    assert.equal(a.isCurrent(a.generation), false);
    assert.throws(() => a.step(frame(1, [0, 1, 0])), /disposed/);
    assert.throws(() => a.activate("PortalAnchor", { time: 1 }), /disposed/);
    assert.equal(b.step(frame(1, [0, 1.2, -2.5])).events.length, 0);
});

await check("pause does not synthesize a crossing across the paused interval", () => {
    const runtime = createRuntime(anchorDocument, bound);
    runtime.step(frame(0, [-3, 1.2, -2.5]));
    assert.equal(runtime.step(frame(1, [0, 1.2, -2.5], { paused: true })).events.length, 0);
    assert.equal(runtime.step(frame(2, [3, 1.2, -2.5])).intents.length, 0);
});

await check("soft-body scene preserves both viewpoints and lobby Anchor intent", async () => {
    const document = await parseX3dDocument(softText, { compatibility: SOFT_BODY_COMPATIBILITY });
    const runtime = createRuntime(document, bound);
    assert.equal(runtime.viewpoints.length, 2);
    near(runtime.viewpoints[0].position, [-10, 1.6, 10]);
    assert.equal(runtime.step(frame(1, [-8.59, 1.2, 2.93])).intents[0].urls[0], "/w/lobby/");
    assert.equal(runtime.activate("PortalAnchor", { time: 2, ...allowed }).metadata, null);
});

await check("invalid calls fail before changing instance state", () => {
    assert.throws(() => createRuntime({ ...anchorDocument }), /validated/);
    assert.throws(() => createRuntime(anchorDocument, { portalBindings: [{ sensor: "Missing", anchor: "PortalAnchor" }] }), /portalBindings/);
    const runtime = createRuntime(anchorDocument, bound);
    runtime.step(frame(1, [0, 1.2, 6]));
    assert.throws(() => runtime.step(frame(0, [0, 1.2, -2.5])), /monotonic/);
    assert.throws(() => runtime.step(frame(2, [0, NaN, 0])), /viewer.position/);
    assert.throws(() => runtime.step(frame(2, [0, 1, 0], { sensorEnabled: { PortalTrigger: "true" } })), /sensorEnabled/);
    assert.equal(runtime.step(frame(2, [0, 1.2, -2.5])).intents.length, 1);
});

await check("inherited controls cannot enable a sensor and repeated sensor instances fail explicitly", async () => {
    const source = JSON.parse(anchorText);
    const sensor = source.X3D.Scene["-children"].find((n) => n.ProximitySensor).ProximitySensor;
    sensor["@DEF"] = "constructor";
    sensor["@enabled"] = false;
    const runtime = createRuntime(await parseX3dDocument(JSON.stringify(source)));
    assert.equal(runtime.step({ time: 0, position: [0, 1.2, -2.5] }).events.length, 0);
    assert.equal(runtime.step({ time: 1, position: [0, 1.2, -2.5], sensorEnabled: { constructor: true } }).events.length, 4);
    source.X3D.Scene["-children"].push({ ProximitySensor: { "@USE": "constructor" } });
    const awaitedDocument = await parseX3dDocument(JSON.stringify(source));
    assert.throws(() => createRuntime(awaitedDocument), /multiply instanced/);
});

await check("sparse host pose and allowlists reject without advancing time, sensor state or intent sequence", () => {
    const runtime = createRuntime(anchorDocument, bound), control = createRuntime(anchorDocument, bound);
    assert.deepEqual(runtime.step(frame(1, [0, 1.2, 6])), control.step(frame(1, [0, 1.2, 6])));
    const position = [0, 1.2, -2.5]; delete position[1];
    const orientation = [0, 0, 1, 0]; delete orientation[1];
    const allowlist = ["PortalAnchor", "PortalAnchor"]; delete allowlist[1];
    assert.throws(() => runtime.step(frame(100, position)), /viewer.position/);
    assert.throws(() => runtime.step(frame(100, [0, 1.2, -2.5], { orientation })), /viewer.orientation/);
    for (const allowedAnchors of [new Array(1), allowlist]) {
        assert.throws(() => runtime.step(frame(100, [0, 1.2, -2.5], { allowedAnchors })), /allowedAnchors/);
        assert.throws(() => runtime.activate("PortalAnchor", { time: 100, allowedAnchors }), /allowedAnchors/);
    }
    assert.equal(runtime.generation, control.generation);
    const entered = runtime.step(frame(2, [0, 1.2, -2.5]));
    assert.deepEqual(entered, control.step(frame(2, [0, 1.2, -2.5])));
    assert.equal(entered.intents[0].sequence, 1);
    assert.deepEqual(runtime.activate("PortalAnchor", { time: 3, ...allowed }), control.activate("PortalAnchor", { time: 3, ...allowed }));
    assert.deepEqual(runtime.step(frame(4, [0, 1.2, 6])), control.step(frame(4, [0, 1.2, 6])));
});

console.log(`X3D runtime checks: ${cases} passed`);
