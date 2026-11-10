import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseX3dDocument, isX3dDocument } from "../runtime/scene-core/public/x3d/json-document.mjs";
import { SOFT_BODY_COMPATIBILITY, SOFT_BODY_SHA256, validateX3dField } from "../runtime/scene-core/public/x3d/profile.mjs";

const anchorText = await readFile(new URL("../web/x3d-worlds/anchor-portal-world.x3d.json", import.meta.url), "utf8");
const softText = await readFile(new URL("../web/x3d-worlds/soft-body.x3d.json", import.meta.url), "utf8");
const sceneText = (children) => JSON.stringify({ X3D: { "@version": "4.0", "@profile": "Interactive", Scene: { "-children": children } } });
let cases = 0;
async function check(name, run) { await run(); cases++; console.log(`PASS ${name}`); }
const rejectScene = (children, pattern) => assert.rejects(parseX3dDocument(sceneText(children)), pattern);

await check("real fixture identities and raw node inventory", async () => {
    assert.equal(createHash("sha256").update(anchorText).digest("hex"), "db7491aaa754aa3e33ef409e3812d6803ecb986b07f9f21cbbbe93405b043441");
    assert.equal(createHash("sha256").update(softText).digest("hex"), SOFT_BODY_SHA256);
    const expected = [
        { Anchor: 1, Appearance: 6, Background: 1, Box: 2, Cylinder: 3, DirectionalLight: 1, FontStyle: 1, Material: 6, MetadataFloat: 1, MetadataSet: 1, MetadataString: 3, NavigationInfo: 1, ProximitySensor: 1, Shape: 6, Text: 1, Transform: 7, Viewpoint: 1, WorldInfo: 1 },
        { Anchor: 1, Appearance: 45, Background: 1, Box: 40, CollidableShape: 44, Cylinder: 2, DirectionalLight: 1, ElevationGrid: 1, EnvironmentLight: 1, FontStyle: 1, Material: 45, ProximitySensor: 1, RigidBody: 44, RigidBodyCollection: 1, Shape: 46, SingleAxisHingeJoint: 1, SoftBody: 4, Sphere: 1, Stitch: 1, Text: 1, Transform: 3, Viewpoint: 2 },
    ];
    for (const [i, text] of [anchorText, softText].entries()) {
        const counts = {};
        const visit = (value) => {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === "object") for (const [name, child] of Object.entries(value)) {
                if (/^[A-Z]/.test(name) && child && typeof child === "object" && !Array.isArray(child)) counts[name] = (counts[name] ?? 0) + 1;
                visit(child);
            }
        };
        visit(JSON.parse(text).X3D.Scene);
        assert.deepEqual(counts, expected[i]);
    }
});

await check("anchor document fields, metadata, defaults and immutability", async () => {
    const document = await parseX3dDocument(anchorText);
    assert.equal(isX3dDocument(document), true);
    assert.equal(isX3dDocument({ ...document }), false);
    assert.equal(Object.keys(document.definitions).length, 11);
    assert.deepEqual(document.inventory.Anchor.fields, ["-children", "-metadata", "@DEF", "@description", "@parameter", "@url"]);
    assert.deepEqual(document.definitions.PortalAnchor.fields.url, ["/w/b/"]);
    assert.equal(document.definitions.PortalTrigger.fields.enabled, true);
    assert.equal(document.definitions.Entry.fields.fieldOfView, 0.9);
    assert.equal(document.nodes.find((n) => n.type === "NavigationInfo").fields.speed, 2);
    const metadata = document.definitions.PortalAnchor.children.metadata.children.value;
    assert.deepEqual(metadata.map((n) => [n.fields.name, n.fields.value]), [
        ["target_world", ["demo-room-b"]], ["target_location_id", ["location-b"]], ["crossing", ["walk-through-or-activate"]], ["radius_m", [1.1]],
    ]);
    assert.deepEqual(document.source, JSON.parse(anchorText));
    assert.throws(() => { document.definitions.Entry.fields.position[0] = 7; }, TypeError);
    assert.throws(() => { document.source.X3D.Scene["-children"].push({}); }, TypeError);
    assert.throws(() => { document.definitions.Other = {}; }, TypeError);
});

await check("strict soft-body rejection and exact-content compatibility", async () => {
    await assert.rejects(parseX3dDocument(softText), /duplicate DEF Features/);
    await assert.rejects(parseX3dDocument(softText + " ", { compatibility: SOFT_BODY_COMPATIBILITY }), /pinned soft-body bytes/);
    await assert.rejects(parseX3dDocument(anchorText, { compatibility: SOFT_BODY_COMPATIBILITY }), /pinned soft-body bytes/);
    await assert.rejects(parseX3dDocument(softText, { compatibility: "filename-only" }), /unsupported compatibility/);
    const document = await parseX3dDocument(softText, { compatibility: SOFT_BODY_COMPATIBILITY });
    assert.equal(document.diagnostics.length, 1);
    assert.match(document.diagnostics[0].path, /RigidBodyCollection.-bodies\[0\]$/);
    assert.deepEqual(document.source, JSON.parse(softText));
    assert.equal(document.definitions.Features.type, "Text");
    assert.deepEqual(document.definitions.Features.fields.string, ["X3D JSON", "Ammo.js", "Three.JS", "WebGPU"]);
    assert.equal(document.nodes.filter((n) => n.type === "RigidBody").length, 41);
    assert.equal(document.nodes.filter((n) => n.type === "SoftBody").length, 2);
    assert.equal(document.nodes.find((n) => n.type === "RigidBodyCollection").children.bodies.length, 43);
    assert.equal(document.definitions.ArmHinge.children.body1, document.definitions.Pylon);
    assert.equal(document.definitions.ArmHinge.children.body2, document.definitions.Arm);
    assert.equal(document.definitions.ArmClothStitch.children.body2, document.definitions.Cloth);
    assert.deepEqual(document.definitions.ArmClothStitch.fields.body1Index, [0, 7, 14, 21, 28, 35]);
});

await check("USE preserves identity and rejects invalid references and cycles", async () => {
    const document = await parseX3dDocument(sceneText([
        { Shape: { "@DEF": "Shared", "-geometry": { Box: {} } } },
        { Transform: { "-children": [{ Shape: { "@USE": "Shared" } }] } },
    ]));
    assert.equal(document.roots[0], document.roots[1].children.children[0]);
    assert.equal(document.nodes.filter((n) => n.type === "Shape").length, 1);
    await rejectScene([{ Shape: { "@USE": "" } }], /@USE/);
    await rejectScene([{ Shape: { "@USE": "Missing" } }], /missing/);
    await rejectScene([{ Shape: { "@DEF": "A" } }, { Transform: { "@USE": "A" } }], /type-mismatched/);
    await rejectScene([{ Shape: { "@DEF": "A" } }, { Shape: { "@USE": "A", "@DEF": "B" } }], /reference only/);
    await rejectScene([{ Transform: { "@DEF": "A", "-children": [{ Transform: { "@USE": "A" } }] } }], /cyclic/);
    await rejectScene([{ Shape: { "@DEF": "A" } }, { Shape: { "@DEF": "A" } }], /duplicate/);
});

await check("explicit unsupported nodes and fields never pass silently", async () => {
    for (const type of ["ROUTE", "Inline", "Script", "ProtoDeclare", "TimeSensor", "PositionInterpolator", "HAnimHumanoid", "Unknown"])
        await rejectScene([{ [type]: {} }], /unsupported node/);
    await rejectScene([{ Transform: { "@scale": [1, 2, 3] } }], /@scale: unsupported/);
    await rejectScene([{ ProximitySensor: { "@centerOfRotation_changed": [0, 0, 0] } }], /unsupported/);
    await rejectScene([{ Shape: { "-geometry": { Material: {} } } }], /unsupported node in this field/);
    await rejectScene([{ Shape: { "@geometry": { Box: {} } } }], /unsupported field/);
    await rejectScene([{ Shape: {}, Transform: {} }], /one node wrapper/);
    await rejectScene([{ Transform: { "-children": {} } }], /expected node array/);
    await assert.rejects(parseX3dDocument('{"X3D":{"@version":"4.0","@profile":"Interactive","Scene":{"-children":[]},"__proto__":{}}}'), /unsupported field/);
});

await check("field types and numeric ranges have precise failure paths", async () => {
    for (const value of [[1, 2], [1, 2, "3"], null]) await rejectScene([{ Transform: { "@translation": value } }], /Transform.@translation: expected vec3/);
    await rejectScene([{ Transform: { "@rotation": [0, 0, 0, 1] } }], /rotation/);
    await rejectScene([{ ProximitySensor: { "@size": [-1, 2, 3] } }], /nonnegative3/);
    await rejectScene([{ ProximitySensor: { "@enabled": 1 } }], /boolean/);
    await rejectScene([{ Viewpoint: { "@fieldOfView": 4 } }], /fov/);
    await rejectScene([{ NavigationInfo: { "@type": ["LOOKAT"] } }], /navigation/);
    await assert.rejects(parseX3dDocument(sceneText([{ Transform: { "@translation": [1, 2, 3] } }]).replace('[1,2,3]', '[1e400,2,3]')), /vec3/);
});

await check("header, component, JSON and size rejection", async () => {
    const base = JSON.parse(sceneText([]));
    for (const [key, value] of [["@version", "5.0"], ["@profile", "Immersive"], ["encoding", "latin1"]]) {
        await assert.rejects(parseX3dDocument(JSON.stringify({ X3D: { ...base.X3D, [key]: value } })), /unsupported/);
    }
    await assert.rejects(parseX3dDocument(JSON.stringify({ X3D: { ...base.X3D, head: { component: [{ "@name": "Scripting", "@level": 1 }] } } })), /unsupported component/);
    await assert.rejects(parseX3dDocument(JSON.stringify({ X3D: { ...base.X3D, head: { component: [{ "@name": "Networking", "@level": 4 }] } } })), /unsupported component/);
    await assert.rejects(parseX3dDocument("{"), /invalid JSON/);
    await assert.rejects(parseX3dDocument(" ".repeat(2_000_001)), /at most/);
    await assert.rejects(parseX3dDocument({}), /expected JSON text/);
    await assert.rejects(parseX3dDocument('{"X3D":{}}'), /unsupported version/);
});

await check("cancelled parsing and no schema or resource fetch", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("unexpected fetch"); };
    try {
        const controller = new AbortController(); controller.abort();
        await assert.rejects(parseX3dDocument(anchorText, { signal: controller.signal }), { name: "AbortError" });
        const pending = new AbortController();
        const result = parseX3dDocument(softText, { compatibility: SOFT_BODY_COMPATIBILITY, signal: pending.signal });
        pending.abort();
        await assert.rejects(result, { name: "AbortError" });
        await parseX3dDocument(anchorText);
    } finally { globalThis.fetch = savedFetch; }
});

await check("public field validation rejects sparse arrays including inherited elements", () => {
    for (const [type, length] of [["vec3", 3], ["rotation", 4], ["color", 3], ["nonnegative3", 3], ["positive3", 3], ["direction", 3],
        ["strings", 1], ["numbers", 1], ["indices", 1], ["units", 1], ["justify", 1], ["navigation", 1]]) {
        assert.throws(() => validateX3dField(type, new Array(length), "sparse"), /sparse: expected/);
    }
    const partial = [0, 1, 2]; delete partial[1];
    assert.throws(() => validateX3dField("vec3", partial, "partial"), /partial: expected vec3/);
    const inherited = [0, 1, 2]; delete inherited[1];
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 1: 0 }));
    assert.throws(() => validateX3dField("vec3", inherited, "inherited"), /inherited: expected vec3/);
});

console.log(`X3D document checks: ${cases} passed`);
