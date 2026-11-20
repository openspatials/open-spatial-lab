// The importer conformance kit (docs/engine/SCENE-CONTRACT-V0.md, section 10), for the X3D and glTF importers.
//   node src/importer-kit-check.mjs            run every check on every fixture, then one planted fault per check
//   node src/importer-kit-check.mjs --write    write the expected layers (src/fixtures/importer-kit/*.layer.json) first
// Pinned inputs: the two X3D worlds, the four glTF files of web/assets/worlds/ and the small hand-made files in
// src/fixtures/importer-kit/. Prints one JSON summary; exits 1 when a check fails or a planted fault is missed.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { x3dImporter } from "../runtime/scene-core/public/import/x3d/to-scene.mjs";
import { gltfImporter, READ_EXTENSIONS } from "../runtime/scene-core/public/import/gltf/to-scene.mjs";
import { parseX3dDocument } from "../runtime/scene-core/public/import/x3d/json-document.mjs";
import { SOFT_BODY_COMPATIBILITY } from "../runtime/scene-core/public/import/x3d/profile.mjs";
import { prepareWorld } from "../web/soft-body-world.mjs";

const CODE = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(CODE, "src", "fixtures", "importer-kit");
const IMPORT_DIR = join(CODE, "runtime", "scene-core", "public", "import");
const WRITE = process.argv.includes("--write");
const read = (path) => readFileSync(join(CODE, path));

// The fixtures: each a source, the importer and its options, and how its source paths are listed for coverage.
const x3d = (name, file, options = {}) => ({ name, format: "x3d", importer: x3dImporter, source: { uri: `/x3d-worlds/${file}`, text: read(`web/x3d-worlds/${file}`).toString("utf8") }, options, mode: "strict" });
const glb = (file) => ({ name: file.replace(/\.glb$/, ""), format: "gltf", importer: gltfImporter, source: { uri: `/assets/worlds/${file}`, bytes: new Uint8Array(read(`web/assets/worlds/${file}`)) }, mode: "report" });
const gltfText = (file, extra = {}) => ({ name: file.replace(/\.gltf$/, ""), format: "gltf", importer: gltfImporter, source: { uri: file, text: readFileSync(join(FIXTURES, file), "utf8") }, mode: "report", ...extra });
const linkedResolve = (calls) => async (uri) => { calls.push(uri); if (uri !== "linked.bin") throw new Error(`unexpected linked file ${uri}`); return new Uint8Array(readFileSync(join(FIXTURES, "linked.bin"))); };
const FIXTURE_LIST = [
    x3d("anchor-portal-world", "anchor-portal-world.x3d.json"),
    x3d("soft-body", "soft-body.x3d.json", { compatibility: SOFT_BODY_COMPATIBILITY, preparePhysics: prepareWorld }),
    glb("Duck.glb"), glb("BoomBox.glb"), glb("Lantern.glb"), glb("ToyCar.glb"),
    gltfText("reserved.gltf"),
    gltfText("linked.gltf", { linked: true }),
];
// Malformed and unsupported sources: each must be rejected with the reason named.
const REJECTIONS = [
    { name: "x3d-not-x3d", importer: x3dImporter, source: { text: "{}" }, mode: "strict", expect: /X3D/ },
    { name: "x3d-unsupported-geometry", importer: x3dImporter, source: { text: JSON.stringify({ X3D: { "@version": "4.0", "@profile": "Interactive", Scene: { "-children": [{ Shape: { "-geometry": { ElevationGrid: {} } } }] } } }) }, mode: "strict", expect: /soft-body topology/ },
    { name: "x3d-report-mode-not-built", importer: x3dImporter, source: { text: read("web/x3d-worlds/anchor-portal-world.x3d.json").toString("utf8") }, mode: "report", expect: /only strict mode/ },
    { name: "gltf-draco-required", importer: gltfImporter, source: { text: readFileSync(join(FIXTURES, "draco-required.gltf"), "utf8") }, mode: "report", expect: /refused: .*compressed-mesh decoder/, refused: true },
    { name: "gltf-basisu-required", importer: gltfImporter, source: { text: readFileSync(join(FIXTURES, "basisu-required.gltf"), "utf8") }, mode: "report", expect: /refused: .*compressed-texture decoder/, refused: true },
    { name: "gltf-version-1", importer: gltfImporter, source: { text: readFileSync(join(FIXTURES, "version-1.gltf"), "utf8") }, mode: "report", expect: /not glTF 2/ },
    { name: "gltf-not-json", importer: gltfImporter, source: { bytes: new Uint8Array([1, 2, 3]) }, mode: "report", expect: /does not parse/ },
    { name: "gltf-linked-without-resolve", importer: gltfImporter, source: { text: readFileSync(join(FIXTURES, "linked.gltf"), "utf8") }, mode: "report", expect: /needs the application's resolve; the importer never fetches/ },
    { name: "gltf-strict-stops-at-tangent", importer: gltfImporter, source: { bytes: new Uint8Array(read("web/assets/worlds/BoomBox.glb")) }, mode: "strict", expect: /attributes\/TANGENT: .*mode "report" keeps it/ },
    { name: "gltf-strict-stops-at-extension", importer: gltfImporter, source: { bytes: new Uint8Array(read("web/assets/worlds/ToyCar.glb")) }, mode: "strict", expect: /extensions\/KHR_materials_clearcoat/ },
];

/**
 * The layer as JSON text: typed number arrays become their type, length and SHA-256, so a byte change shows. A source
 * header (the author's own head lines, kept as written) is saved as the SHA-256 of its JSON, so equality stays exact.
 */
function canonical(value) {
    const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    return JSON.stringify(value, (key, v) => (key === "header" && v && typeof v === "object" ? { $sha256: digest(v) } : ArrayBuffer.isView(v)
        ? { $typed: v.constructor.name, length: v.length, sha256: createHash("sha256").update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).digest("hex") } : v), 1);
}

async function runImport(fixture, extra = {}) {
    const calls = [];
    const resolve = fixture.linked ? linkedResolve(calls) : undefined;
    const result = await fixture.importer.import(fixture.source, { resolve, mode: fixture.mode, options: { name: "world", ...fixture.options }, ...extra });
    return { ...result, resolveCalls: calls };
}

// Source paths: every node of an X3D document; every item of a glTF file (bufferViews and buffers are packing, not
// content: contract section 9.3), and every declared extension.
async function sourcePaths(fixture) {
    if (fixture.format === "x3d") {
        const document = await parseX3dDocument(fixture.source.text, { compatibility: fixture.options.compatibility });
        return document.nodes.map((node) => ({ path: node.path, type: node.type }));
    }
    const json = JSON.parse(fixture.source.text ?? (() => {
        const bytes = fixture.source.bytes, view = new DataView(bytes.buffer, bytes.byteOffset);
        return new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)));
    })());
    const paths = [];
    for (const kind of ["scenes", "nodes", "materials", "textures", "samplers", "images", "cameras", "skins", "animations", "accessors"]) (json[kind] ?? []).forEach((_, i) => paths.push({ path: `${kind}/${i}`, type: kind }));
    (json.meshes ?? []).forEach((mesh, i) => mesh.primitives.forEach((_, j) => paths.push({ path: `meshes/${i}/primitives/${j}`, type: "primitive" })));
    (json.extensions?.KHR_lights_punctual?.lights ?? []).forEach((_, i) => paths.push({ path: `extensions/KHR_lights_punctual/lights/${i}`, type: "light" }));
    for (const extension of json.extensionsUsed ?? []) paths.push({ path: extension, type: "extension" });
    return paths;
}

function strings(value, out = new Set()) {
    if (typeof value === "string") out.add(value);
    else if (value && typeof value === "object" && !ArrayBuffer.isView(value)) for (const v of Object.values(value)) strings(v, out);
    return out;
}

/** Paths of the source that appear nowhere: not as an entity, part of one, an extras entry, a layer field or a report line. */
function uncovered(fixture, paths, layer, report) {
    const seen = strings({ layer: { ...layer, report: undefined }, report }), all = [...seen];
    const reportPaths = [...report.kept, ...report.skipped, ...report.refused, ...report.diagnostics].map((r) => r.path);
    if (fixture.format === "x3d") {
        const entityPaths = layer.entities.map((e) => e.source.path);
        const layerLevel = { Background: layer.environment?.background, NavigationInfo: layer.navigation, WorldInfo: layer.info, EnvironmentLight: layer.environment?.color };
        return paths.filter(({ path, type }) => !(entityPaths.includes(path) || reportPaths.includes(path)
            || entityPaths.some((p) => path.startsWith(`${p}.`)) || (type in layerLevel && layerLevel[type] != null)));
    }
    // A declared extension is read (the importer's own list), or a report line names it.
    return paths.filter(({ path, type }) => (type === "extension"
        ? !(READ_EXTENSIONS.includes(path) || reportPaths.some((p) => p.endsWith(`/extensions/${path}`) || p === `extensionsUsed/${path}`))
        : !(seen.has(path) || all.some((s) => s.startsWith(`${path}/`)))));
}

// The no-renderer rule: the static imports of every importer file, followed through the engine folder.
function importsOf(text) {
    return [...text.matchAll(/\b(?:import|export)\s+(?:[^"';]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);
}
function rendererImports(extraFiles = {}) {
    const files = [];
    for (const dir of readdirSync(IMPORT_DIR)) for (const name of readdirSync(join(IMPORT_DIR, dir))) if (name.endsWith(".mjs")) files.push(join(IMPORT_DIR, dir, name));
    const queue = [...files, ...Object.keys(extraFiles)], seen = new Set(), crossings = [];
    while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        const text = extraFiles[file] ?? readFileSync(file, "utf8");
        for (const specifier of importsOf(text)) {
            const target = specifier.startsWith(".") ? resolvePath(dirname(file), specifier) : specifier;
            const rel = target.startsWith("/") ? relative(join(CODE, "runtime", "scene-core", "public"), target) : target;
            if (/^three(\/|$)/.test(specifier) || /(^|\/)(render|render-adapter|vendor\/three)\//.test(rel) || /x3d\/(own-x3d-render-adapter|scene-renderer)\.mjs$/.test(rel)) crossings.push(`${relative(CODE, file)} -> ${specifier}`);
            else if (target.startsWith("/") && target.startsWith(join(CODE, "runtime"))) queue.push(target);
        }
    }
    return crossings;
}

const expectedPath = (fixture) => join(FIXTURES, `${fixture.name}.layer.json`);

// The checks. Each takes a fixture (or none) and the importer to use, and throws on failure.
const CHECKS = {
    "equals-saved": async (fixture, mutate = (r) => r) => {
        const result = mutate(await runImport(fixture));
        const text = canonical({ layer: result.layer, report: result.report });
        if (WRITE && !mutate.planted) writeFileSync(expectedPath(fixture), `${text}\n`);
        const saved = readFileSync(expectedPath(fixture), "utf8").trimEnd();
        if (text !== saved) throw new Error(`${fixture.name}: the layer differs from ${relative(CODE, expectedPath(fixture))}`);
    },
    "same-bytes": async (fixture) => {
        const a = await runImport(fixture), b = await runImport(fixture);
        if (canonical(a) !== canonical(b)) throw new Error(`${fixture.name}: two runs gave different layers`);
    },
    "coverage": async (fixture, mutate = (r) => r) => {
        const { layer, report } = mutate(await runImport(fixture));
        const missing = uncovered(fixture, await sourcePaths(fixture), layer, report);
        if (missing.length) throw new Error(`${fixture.name}: ${missing.length} source paths appear nowhere: ${missing.slice(0, 5).map((m) => m.path).join(", ")}`);
    },
    "no-fetch": async (fixture) => {
        const real = globalThis.fetch, calls = [];
        globalThis.fetch = (...args) => { calls.push(String(args[0])); return Promise.reject(new Error("the kit refuses fetch")); };
        try { const { resolveCalls } = await runImport(fixture); if (fixture.linked && resolveCalls.join() !== "linked.bin") throw new Error(`${fixture.name}: linked file not taken through resolve (${resolveCalls})`); }
        catch (error) { if (!calls.length) throw error; }
        finally { globalThis.fetch = real; }
        if (calls.length) throw new Error(`${fixture.name}: the importer called fetch(${calls[0]})`);
    },
    "cancel": async (fixture) => {
        for (const when of ["before", "during"]) {
            const controller = new AbortController();
            if (when === "before") controller.abort();
            const pending = runImport(fixture, { signal: controller.signal });
            if (when === "during") controller.abort();
            const outcome = await pending.then((value) => ({ value }), (error) => ({ error }));
            if (!outcome.error || outcome.error.name !== "AbortError") throw new Error(`${fixture.name}: cancelled ${when} the import, it ${outcome.error ? `failed with ${outcome.error.message}` : "returned a layer"}`);
        }
    },
};
const GLOBAL_CHECKS = {
    "no-renderer-imports": async (extraFiles) => {
        const crossings = rendererImports(extraFiles);
        if (crossings.length) throw new Error(`importer files import Three.js or renderer files: ${crossings.join("; ")}`);
    },
    "rejections": async (list = REJECTIONS) => {
        for (const item of list) {
            const outcome = await item.importer.import(item.source, { mode: item.mode, options: { name: "world" } }).then((value) => ({ value }), (error) => ({ error }));
            if (!outcome.error) throw new Error(`${item.name}: imported, expected a rejection matching ${item.expect}`);
            if (!item.expect.test(outcome.error.message)) throw new Error(`${item.name}: rejected with "${outcome.error.message}", expected ${item.expect}`);
            if (item.refused && !outcome.error.report?.refused?.length) throw new Error(`${item.name}: the refusal carries no report`);
        }
    },
};

const results = [];
let failed = 0;
for (const fixture of FIXTURE_LIST) {
    for (const [name, check] of Object.entries(CHECKS)) {
        try { await check(fixture); results.push({ check: name, fixture: fixture.name, ok: true }); }
        catch (error) { failed++; results.push({ check: name, fixture: fixture.name, ok: false, error: error.message }); }
    }
}
for (const [name, check] of Object.entries(GLOBAL_CHECKS)) {
    try { await check(); results.push({ check: name, ok: true }); }
    catch (error) { failed++; results.push({ check: name, ok: false, error: error.message }); }
}

// One planted fault per check. Each must make its check fail.
const planted = (mutate) => Object.assign(mutate, { planted: true });
const anchor = FIXTURE_LIST[0], duck = FIXTURE_LIST[2];
const wrap = (fixture, importFn) => ({ ...fixture, importer: { ...fixture.importer, import: importFn } });
let counter = 0;
const FAULTS = [
    { check: "equals-saved", name: "a changed entity name", run: () => CHECKS["equals-saved"](duck, planted((r) => ({ ...r, layer: { ...r.layer, entities: r.layer.entities.map((e, i) => (i ? e : { ...e, name: "planted" })) } }))) },
    { check: "same-bytes", name: "an importer that stamps a run counter", run: () => CHECKS["same-bytes"](wrap(duck, async (s, o) => { const r = await gltfImporter.import(s, o); return { ...r, layer: { ...r.layer, extras: { run: ++counter } } }; })) },
    { check: "coverage", name: "the first root entity dropped", run: () => CHECKS.coverage(anchor, (r) => ({ ...r, layer: { ...r.layer, entities: r.layer.entities.filter((e) => e !== r.layer.entities.find((x) => x.parent === null)) } })) },
    { check: "no-fetch", name: "an importer that fetches", run: () => CHECKS["no-fetch"](wrap(duck, async (s, o) => { await fetch("https://example.invalid/Duck.glb"); return gltfImporter.import(s, o); })) },
    { check: "cancel", name: "an importer that ignores its signal", run: () => CHECKS.cancel(wrap(duck, (s, o) => gltfImporter.import(s, { ...o, signal: undefined }))) },
    { check: "no-renderer-imports", name: "an importer file that imports three", run: () => GLOBAL_CHECKS["no-renderer-imports"]({ [join(IMPORT_DIR, "gltf", "planted.mjs")]: 'import * as THREE from "three";\n' }) },
    { check: "rejections", name: "an importer that swallows a refusal", run: () => GLOBAL_CHECKS.rejections([{ ...REJECTIONS[3], importer: { import: async (s, o) => gltfImporter.import(s, o).catch(() => ({ layer: null, report: null })) } }]) },
];
const faults = [];
for (const fault of FAULTS) {
    const outcome = await fault.run().then(() => null, (error) => error.message);
    faults.push({ check: fault.check, fault: fault.name, caught: outcome !== null, by: outcome });
}
const missed = faults.filter((f) => !f.caught).length;
const toyCar = (await runImport(FIXTURE_LIST[5])).report;
const summary = {
    kit: "importer-kit/0", importers: ["x3d-json", "gltf"], fixtures: FIXTURE_LIST.map((f) => f.name), rejections: REJECTIONS.map((r) => r.name),
    checks: results.length, passed: results.length - failed, failed, faultsPlanted: faults.length, faultsCaught: faults.length - missed, faultsMissed: missed,
    toyCarUnreadExtensions: toyCar.kept.filter((k) => k.type === "extension").map((k) => k.path),
    results: results.filter((r) => !r.ok), faults,
};
console.log(JSON.stringify(summary, null, 2));
console.log(`importer kit: ${summary.passed}/${summary.checks} checks pass on ${FIXTURE_LIST.length} fixtures and ${REJECTIONS.length} rejections; ${summary.faultsCaught} of ${faults.length} planted faults caught`);
process.exitCode = failed || missed ? 1 : 0;
