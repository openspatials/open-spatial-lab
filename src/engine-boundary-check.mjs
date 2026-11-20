// The engine boundary check (docs/engine/STRATEGY.md, rule 4): fails when one engine part reaches into another.
//   node src/engine-boundary-check.mjs                 check the engine folder, then one planted fault per rule
//   node src/engine-boundary-check.mjs --root <dir>    check another copy of runtime/scene-core/public (a planted break)
// Rules 1 to 4 are milestone M1's boundary greps made into one check;
// rules 5 to 7 are milestone M2's. Prints one JSON summary; exits 1 when a rule is broken or a planted fault is missed.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootAt = process.argv.indexOf("--root");
const ENGINE = rootAt > 0 ? resolve(process.argv[rootAt + 1]) : join(CODE, "runtime", "scene-core", "public");

/** The files of a folder of the engine, recursively; `files` overrides contents (planted faults). */
const filesIn = (dir) => {
    const at = join(ENGINE, dir);
    if (!existsSync(at)) return [];
    return readdirSync(at).flatMap((name) => {
        const path = join(at, name);
        return statSync(path).isDirectory() ? filesIn(join(dir, name)) : name.endsWith(".mjs") || name.endsWith(".js") ? [join(dir, name)] : [];
    });
};
const reader = (overrides) => (file) => overrides[file] ?? readFileSync(join(ENGINE, file), "utf8");
const lines = (text) => text.split("\n").map((line, i) => ({ n: i + 1, line }));
const importsOf = (text) => [...text.matchAll(/\b(?:import|export)\s+(?:[^"';]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);
/** An import of `file`, as a path inside the engine folder (or the bare specifier). */
const target = (file, specifier) => (specifier.startsWith(".") ? relative(ENGINE, resolve(ENGINE, dirname(file), specifier)).split("\\").join("/") : specifier);

const IMPORTERS = ["import/x3d", "import/gltf"];
const RENDERER = { dirs: ["render", "render-adapter"], files: ["x3d/own-x3d-render-adapter.mjs", "x3d/scene-renderer.mjs"] };
const rendererFiles = () => [...RENDERER.dirs.flatMap(filesIn), ...RENDERER.files.filter((f) => existsSync(join(ENGINE, f)))];
const READER_FORWARDS = /^x3d\/(json-document|profile|scene-runtime)\.mjs$/;
const DOCUMENT_METHODS = /loadDocument|cancelDocument|stepDocument|activateAnchor|pickRay|documentState|isX3dDocument|parseX3dDocument/;
const FORMAT_NAME = /x3d|gltf|\bglb\b|\busdz?\b|collada|\bfbx\b/i;
const MANAGER = "scene/manager.mjs";
const FORWARD_EXPORTS = ["createX3dRuntime", "createX3dSceneHost"];

/** Each rule returns its crossings, as "file:line: what". */
const RULES = {
    // M1
    "1 importers name no Three.js": (read) => IMPORTERS.flatMap(filesIn).flatMap((f) => lines(read(f)).filter(({ line }) => /three/i.test(line)).map(({ n, line }) => `${f}:${n}: ${line.trim()}`)),
    "2 no renderer file imports an importer, a reader forward or the Scene Manager": (read) => rendererFiles().flatMap((f) => importsOf(read(f)).map((s) => [s, target(f, s)])
        .filter(([, t]) => t.startsWith("import/") || READER_FORWARDS.test(t) || t === MANAGER).map(([s]) => `${f}: imports ${s}`)),
    "3 render-adapter/ has no loadDocument": (read) => filesIn("render-adapter").flatMap((f) => lines(read(f)).filter(({ line }) => /loadDocument/.test(line)).map(({ n }) => `${f}:${n}: loadDocument`)),
    "4 no renderer file has a document method": (read) => rendererFiles().flatMap((f) => lines(read(f)).filter(({ line }) => DOCUMENT_METHODS.test(line)).map(({ n, line }) => `${f}:${n}: ${line.trim().slice(0, 100)}`)),
    // M2
    "5 importers import no Three.js and no renderer file": (read) => IMPORTERS.flatMap(filesIn).flatMap((f) => importsOf(read(f)).map((s) => [s, target(f, s)])
        .filter(([s, t]) => /^three(\/|$)/.test(s) || /^(render|render-adapter|vendor\/three)\//.test(t) || RENDERER.files.includes(t)).map(([s]) => `${f}: imports ${s}`)),
    "6 scene/manager.mjs names no format outside its forwards block": (read) => {
        const text = read(MANAGER), begin = text.indexOf("// forwards:begin"), end = text.indexOf("// forwards:end");
        if (begin < 0 || end < begin) return [`${MANAGER}: no "// forwards:begin" ... "// forwards:end" block`];
        const crossings = [];
        const before = text.slice(0, begin), block = text.slice(begin, end), after = text.slice(end + "// forwards:end".length);
        for (const [part, offset] of [[before, 0], [after, text.slice(0, end).split("\n").length - 1]]) {
            for (const { n, line } of lines(part)) if (FORMAT_NAME.test(line)) crossings.push(`${MANAGER}:${n + offset}: ${line.trim().slice(0, 100)}`);
            for (const s of importsOf(part)) if (target(MANAGER, s).startsWith("import/")) crossings.push(`${MANAGER}: imports the importer ${s} outside the forwards block`);
        }
        for (const [, name] of block.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)) if (!FORWARD_EXPORTS.includes(name)) crossings.push(`${MANAGER}: forwards block exports ${name}, not an old name`);
        return crossings;
    },
    "7 the Scene, Interaction and Physics import no renderer file": (read) => ["scene", "interaction", "physics", "core"].flatMap(filesIn).flatMap((f) => importsOf(read(f)).map((s) => [s, target(f, s)])
        .filter(([s, t]) => /^three(\/|$)/.test(s) || /^render\//.test(t) || (t.startsWith("render-adapter/") && f !== "core/math.mjs")).map(([s]) => `${f}: imports ${s}`)),
};

const run = (overrides = {}) => Object.entries(RULES).map(([rule, check]) => ({ rule, crossings: check(reader(overrides)) }));
const results = run();
const broken = results.filter((r) => r.crossings.length);

// One planted fault per rule: a file's text changed in memory; the rule must report a crossing.
const append = (file, text) => ({ [file]: `${readFileSync(join(ENGINE, file), "utf8")}\n${text}\n` });
const FAULTS = rootAt > 0 ? [] : [
    { rule: "1 importers name no Three.js", edit: append("import/x3d/to-scene.mjs", "// three") },
    { rule: "2 no renderer file imports an importer, a reader forward or the Scene Manager", edit: append("render/three/scene-view.mjs", 'import { gltfImporter } from "../../import/gltf/to-scene.mjs";') },
    { rule: "3 render-adapter/ has no loadDocument", edit: append("render-adapter/three-render-adapter.mjs", "function loadDocument() {}") },
    { rule: "4 no renderer file has a document method", edit: append("x3d/own-x3d-render-adapter.mjs", "const pickRay = null;") },
    { rule: "5 importers import no Three.js and no renderer file", edit: append("import/gltf/read.mjs", 'import { createSceneView } from "../../render/three/scene-view.mjs";') },
    { rule: "6 scene/manager.mjs names no format outside its forwards block", edit: { [MANAGER]: readFileSync(join(ENGINE, MANAGER), "utf8").replace("// forwards:begin", 'const preferred = "gltf";\n// forwards:begin') } },
    { rule: "7 the Scene, Interaction and Physics import no renderer file", edit: append("interaction/sensors.mjs", 'import { createSceneView } from "../render/three/scene-view.mjs";') },
];
const faults = FAULTS.map(({ rule, edit }) => {
    const found = run(edit).find((r) => r.rule === rule).crossings;
    return { rule, file: Object.keys(edit)[0], caught: found.length > 0, by: found[0] ?? null };
});
const missed = faults.filter((f) => !f.caught).length;
console.log(JSON.stringify({ engine: relative(CODE, ENGINE) || ENGINE, rules: results.length, broken: broken.length, results, faultsPlanted: faults.length, faultsCaught: faults.length - missed, faults }, null, 2));
console.log(`engine boundary: ${results.length - broken.length}/${results.length} rules hold${broken.length ? ` (broken: ${broken.map((b) => b.rule.split(" ")[0]).join(", ")})` : ""}; ${faults.length - missed} of ${faults.length} planted faults caught`);
process.exitCode = broken.length || missed ? 1 : 0;
