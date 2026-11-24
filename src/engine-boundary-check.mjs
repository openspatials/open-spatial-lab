// The engine boundary check (docs/engine/STRATEGY.md, rule 4): fails when one engine part reaches into another.
//   node src/engine-boundary-check.mjs                 check the engine folder, then one planted fault per rule
//   node src/engine-boundary-check.mjs --root <dir>    check another copy of runtime/scene-core/public (a planted break)
// Rules 1 to 4 are milestone M1's boundary greps made into one check; rules 5 to 7 are milestone M2's; rule 8 is the
// milestone "skins in the Scene" (rule 6 lost its forwards exception there). Rule 8 also reads the document route's
// application files under web/ (from this code folder, also with --root). Rule 9 is the milestone "the first dressed
// avatar": a processor's output reaches the engine only as a file (docs/engine/PROCESSOR-CONTRACT-V0.md), so no engine
// file imports the garment processor (fitting/garments/ in the avatars build), by path or by name. Rules 10 and 11 are the
// milestone "avatar parts get engine folders", step 1 (one copy of the rig code): nothing under process/ imports a renderer
// file, the Scene Manager, an importer or a file outside the engine (web/, the avatars build); and the rig code
// (process/rig/roles.mjs, process/rig/rig.mjs) exists once in this code folder: any other .mjs or .js file that exports at
// least half of a rig file's names, and is not a one-line forward to it, is a second copy. Rule 11 also reads every code
// file outside the engine folder (from this code folder, also with --root). Step 2 (clip mapping) adds
// process/clips/map-clips.mjs to rule 11's one-copy files and rule 12: process/clips/ imports only process/rig/ and
// three.js (three.js is a named exception until the Scene's animation tracks are designed), and process/rig/ imports
// nothing of process/clips/. Step 3 (item placement and equipment) adds rules 13 to 16: nothing under process/items/
// imports a loader; item placement exists once (no file but process/items/holds.mjs and process/items/placement.mjs defines
// fitHold, fitWorn, fitFace, fitBack, heldPlacement or itemRecord; the frozen vendor copy is allowed by name only);
// process/items/ does not import the solvers; and process/rig/ never imports process/items/. Step 4 (body measuring) puts body
// measuring in its own folder, process/body/, which reads clip mapping and the grip and back frames (rule 26: process/body/
// imports only three.js and process/rig/, clips/, items/, mesh/, and none of those four imports it), and adds rules 17 to 21: body measuring and the item measures import
// only their named engine files and three.js; nothing under process/ imports a node: module, a loader or the Node tools
// (runtime/scene-core/tools/, beside the engine folder); nothing in the engine or under web/ imports the Node tools; a
// tool imports only node:, three.js, its own folder and process/; and measureBody and gripError each exist once. Prints
// one JSON summary; exits 1 when a rule is broken or a planted fault is missed.
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
// This code folder's .mjs and .js files outside the engine folder, named relative to it (rule 11).
const CODE_SKIP = new Set(["node_modules", ".git", ".dev", ".runtime", "diagnostics", "evidence", "coverage"]);
const codeFilesIn = (dir) => readdirSync(join(CODE, dir)).flatMap((name) => {
    const rel = dir ? `${dir}/${name}` : name, path = join(CODE, rel);
    if (CODE_SKIP.has(name) || rel === "runtime/scene-core") return [];
    return statSync(path).isDirectory() ? codeFilesIn(rel) : /\.m?js$/.test(name) ? [rel] : [];
});
let codeFileSet = null;
const codeFiles = () => [...(codeFileSet ??= new Set(codeFilesIn("")))];
/** Engine files are read under the engine folder; files named "web/..." and the code files of rule 11 under this code folder. */
const disk = new Map();
const reader = (overrides) => (file) => overrides[file] ?? disk.get(file) ?? disk.set(file, readFileSync(file.startsWith("web/") || codeFileSet?.has(file) ? join(CODE, file) : join(ENGINE, file), "utf8")).get(file);
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
// The document route's application files: the route's own module whole, and the controller's marked pose writer.
const ROUTE_FILE = "web/own-x3d-document.mjs";
const CONTROLLER = "web/scene-runtime-controller.mjs";
const ROUTE_BLOCK = ["// document-route:begin", "// document-route:end"];
const SKIN_CALL = /\b(bindSkin|setSkinPose|disposeSkin)\s*(\?\.)?\s*\(/;
/** Every engine file but vendor/, the root's files included. */
const engineFiles = () => ["", ...readdirSync(ENGINE).filter((name) => statSync(join(ENGINE, name)).isDirectory() && name !== "vendor")]
    .flatMap((dir) => (dir ? filesIn(dir) : readdirSync(ENGINE).filter((name) => /\.m?js$/.test(name))));
// The garment processor, in the avatars build: its folder (fitting/garments/), or any module named for garments.
const GARMENT_PROCESSOR = /(^|[\/])fitting[\/]garments([\/]|$)|garment/i;
const requiresOf = (text) => [...text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
// The avatar parts' folder (milestone "avatar parts get engine folders"). A processor needs no engine system (Processor
// contract rule 1); three.js maths is allowed.
const PROCESS = "process";
const resolvesOf = (text) => [...text.matchAll(/\bimport\.meta\.resolve\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
const RIG_FILES = ["process/rig/roles.mjs", "process/rig/rig.mjs", "process/clips/map-clips.mjs"];
const CLIPS = "process/clips";
// Item placement (milestone "avatar parts get engine folders", step 3). The frozen vendor tree holds the old copy of both
// files (fitting/holds.mjs and mannequin/web/avatar/equipment.mjs); it is allowed by name only, as in rule 11.
const ITEMS = "process/items";
const ITEM_FILES = ["process/items/holds.mjs", "process/items/placement.mjs"];
const ITEM_NAMES = ["fitHold", "fitWorn", "fitFace", "fitBack", "heldPlacement", "itemRecord"];
const ITEM_FROZEN = ["web/vendor/avatar-evaluator-v1/fitting/holds.mjs", "web/vendor/avatar-evaluator-v1/mannequin/web/avatar/equipment.mjs"];
// A definition: a function declaration, or a const/let/var bound to that one name (not a destructured forward or re-export).
const definesOf = (text) => new Set([
    ...[...text.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
]);
const LOADER = /(^|\/)(loaders\/|[A-Za-z]*Loader\.js$)/;
// Body measuring (milestone "avatar parts get engine folders", step 4). The rig code is the two files rules 12 and 16 keep
// free of clips and items; body measuring sits beside it and reads them. The Node tools sit beside the engine folder and
// are read as "../tools/<file>" (with --root, the folder "tools" beside the given copy, when there is one).
const RIG_CODE = ["process/rig/roles.mjs", "process/rig/rig.mjs"];
const MEASURING = {
    "process/body/body-details.mjs": ["process/rig/roles.mjs", "process/rig/rig.mjs", "process/clips/map-clips.mjs", "process/items/holds.mjs", "process/mesh/mesh-math.mjs"],
    "process/items/measures.mjs": ["process/rig/roles.mjs", "process/items/holds.mjs"],
};
const ONCE = { measureBody: "process/body/body-details.mjs", gripError: "process/items/measures.mjs" };
const TOOLS = "../tools";
const toolFiles = () => { const at = join(ENGINE, TOOLS); return existsSync(at) ? readdirSync(at).filter((n) => /\.m?js$/.test(n)).map((n) => `${TOOLS}/${n}`) : []; };
const inTools = (t) => t === TOOLS || t.startsWith(`${TOOLS}/`);
const SOLVERS = /(^|\/)solvers\.mjs$/;
// The names a file exports: declarations, export lists (by their outside name) and destructured forwards.
const exportsOf = (text) => new Set([
    ...[...text.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\bexport\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(",").map((p) => p.trim().split(/\s+as\s+/).pop())),
    ...[...text.matchAll(/\bexport\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/g)].flatMap((m) => m[1].split(",").map((p) => p.split(":").pop().trim())),
].filter(Boolean));
// A forward: one line of code (comments aside) that names the rig file it forwards to.
const forwardsTo = (text, rigFile) => { const code = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")); return code.length === 1 && code[0].includes(rigFile); };
// A frozen copy is allowed while nothing outside its own tree imports it. web/vendor/avatar-evaluator-v1/ is the avatar
// runtime 1.0.0's vendor source (web/avatar/runtime/RELEASE.json: "the vendor folder stays in place"); deleting it is the Lab's.
const FROZEN = [{ copy: "web/vendor/avatar-evaluator-v1/fitting/", tree: "web/vendor/avatar-evaluator-v1/" }];
const skinCalls = (file, text, offset = 0) => lines(text).filter(({ line }) => SKIN_CALL.test(line)).map(({ n, line }) => `${file}:${n + offset}: ${line.trim().slice(0, 100)}`);

/** Each rule returns its crossings, as "file:line: what". */
// The movers (milestone "avatar parts get engine folders", step 5): the Animator's motion drivers under animation/ and the
// Navigation system's movement models under navigation/ (docs/engine/MOVER-CONTRACTS-V0.md, section 1). A driver never
// moves the body over the floor, so the two folders import nothing of each other. three.js is allowed (the clip player and
// its maths) until the Scene's animation tracks are designed, as for process/clips/.
const MOVERS = ["animation", "navigation"];
const IK = "animation/drivers/humanoid/vendor/avatar-ik.mjs";
const MOVER_FILES = ["animation/drivers/humanoid/avatar-motion.mjs", "animation/drivers/humanoid/solvers.mjs", IK, "navigation/humanoid/locomotion.mjs"];
const MOVER_NAMES = ["AvatarMotion", "SolverStack", "Locomotion", "solveTwoBoneLeg", "solveArmAvoid"];
// The avatar runtime 1.0.0's vendor source holds the old copy of all four; allowed by name while nothing outside its tree imports it.
const MOVER_FROZEN = ["web/vendor/avatar-evaluator-v1/mannequin/web/avatar/avatar-motion.mjs", "web/vendor/avatar-evaluator-v1/mannequin/web/avatar/locomotion.mjs",
    "web/vendor/avatar-evaluator-v1/fitting/solvers.mjs", "web/vendor/avatar-evaluator-v1/fitting/vendor/avatar-ik.mjs"];
const MOVER_FROZEN_TREE = "web/vendor/avatar-evaluator-v1/";
const classesOf = (text) => new Set([...text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
const specifiersOf = (text) => [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)];

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
    "6 scene/manager.mjs names no format and imports no importer": (read) => {
        const text = read(MANAGER);
        return [...lines(text).filter(({ line }) => FORMAT_NAME.test(line)).map(({ n, line }) => `${MANAGER}:${n}: ${line.trim().slice(0, 100)}`),
            ...importsOf(text).filter((s) => target(MANAGER, s).startsWith("import/")).map((s) => `${MANAGER}: imports the importer ${s}`)];
    },
    "7 the Scene, Interaction and Physics import no renderer file": (read) => ["scene", "interaction", "physics", "core"].flatMap(filesIn).flatMap((f) => importsOf(read(f)).map((s) => [s, target(f, s)])
        .filter(([s, t]) => /^three(\/|$)/.test(s) || /^render\//.test(t) || (t.startsWith("render-adapter/") && f !== "core/math.mjs")).map(([s]) => `${f}: imports ${s}`)),
    // Skins in the Scene
    "8 on the document route only the Renderer calls bindSkin, setSkinPose or disposeSkin": (read) => {
        const renderer = new Set(rendererFiles());
        const engine = engineFiles().filter((f) => !renderer.has(f)).flatMap((f) => skinCalls(f, read(f)));
        const controller = read(CONTROLLER), begin = controller.indexOf(ROUTE_BLOCK[0]), end = controller.indexOf(ROUTE_BLOCK[1]);
        if (begin < 0 || end < begin) return [...engine, `${CONTROLLER}: no "${ROUTE_BLOCK[0]}" ... "${ROUTE_BLOCK[1]}" block`];
        return [...engine, ...skinCalls(ROUTE_FILE, read(ROUTE_FILE)),
            ...skinCalls(CONTROLLER, controller.slice(begin, end), controller.slice(0, begin).split("\n").length - 1)];
    },
    // The first dressed avatar
    "9 no engine file imports the garment processor": (read) => engineFiles().flatMap((f) => {
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text)].filter((s) => GARMENT_PROCESSOR.test(s) || GARMENT_PROCESSOR.test(target(f, s)))
            .map((s) => `${f}: imports ${s}`);
    }),
    // Avatar parts get engine folders, step 1: one copy of the rig code
    "10 nothing under process/ imports a renderer file, the Scene Manager, an importer or a file outside the engine": (read) => filesIn(PROCESS).flatMap((f) => {
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].map((s) => [s, target(f, s)])
            .filter(([s, t]) => /^(render|render-adapter)\//.test(t) || RENDERER.files.includes(t) || t === MANAGER || t.startsWith("import/") || READER_FORWARDS.test(t)
                || t.startsWith("..") || s.startsWith("/") || s.startsWith("#") || /(^|\/)web\//.test(s))
            .map(([s]) => `${f}: imports ${s}`);
    }),
    "11 the rig code and the clip mapping exist once: no second file exports a rig or clip-mapping file's names": (read) => {
        const rig = RIG_FILES.filter((r) => existsSync(join(ENGINE, r)));
        if (rig.length < RIG_FILES.length) return RIG_FILES.filter((r) => !rig.includes(r)).map((r) => `${r}: missing`);
        const names = Object.fromEntries(rig.map((r) => [r, exportsOf(read(r))]));
        const others = [...engineFiles().filter((f) => !RIG_FILES.includes(f)), ...codeFiles()];
        const frozen = (f) => FROZEN.some(({ copy }) => f.startsWith(copy));
        const copies = others.filter((f) => !frozen(f)).flatMap((f) => {
            const text = read(f), mine = exportsOf(text);
            return rig.flatMap((r) => {
                const shared = [...names[r]].filter((n) => mine.has(n));
                return shared.length >= Math.max(2, Math.ceil(names[r].size / 2)) && !forwardsTo(text, r)
                    ? [`${f}: a second copy of ${r} (${shared.length} of its ${names[r].size} exports)`] : [];
            });
        });
        const frozenUsed = codeFiles().filter((f) => !FROZEN.some(({ tree }) => f.startsWith(tree))).flatMap((f) => [...importsOf(read(f)), ...requiresOf(read(f))]
            .filter((s) => s.startsWith(".")).map((s) => relative(CODE, resolve(CODE, dirname(f), s)).split("\\").join("/"))
            .filter((t) => frozen(t)).map((t) => `${f}: imports the frozen copy ${t}`));
        return [...copies, ...frozenUsed];
    },
    // Avatar parts get engine folders, step 2: clip mapping
    "12 process/clips/ imports only process/rig/ and three.js; process/rig/ imports nothing of process/clips/": (read) => [
        ...filesIn(CLIPS).flatMap((f) => {
            const text = read(f);
            return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].map((s) => [s, target(f, s)])
                .filter(([s, t]) => !(s === "three" || t.startsWith("process/rig/") || t.startsWith(`${CLIPS}/`))).map(([s]) => `${f}: imports ${s}`);
        }),
        ...filesIn("process/rig").flatMap((f) => {
            const text = read(f);
            return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].filter((s) => target(f, s).startsWith(`${CLIPS}/`) || /(^|\/)process\/clips\//.test(s))
                .map((s) => `${f}: imports ${s}`);
        }),
    ],
    // Avatar parts get engine folders, step 3: item placement and equipment
    "13 nothing under process/items/ imports a loader": (read) => filesIn(ITEMS).flatMap((f) => {
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].filter((s) => LOADER.test(s) || LOADER.test(target(f, s)))
            .map((s) => `${f}: imports ${s}`);
    }),
    "14 item placement exists once: no other file defines fitHold, fitWorn, fitFace, fitBack, heldPlacement or itemRecord": (read) => {
        const present = ITEM_FILES.filter((f) => existsSync(join(ENGINE, f)));
        if (present.length < ITEM_FILES.length) return ITEM_FILES.filter((f) => !present.includes(f)).map((f) => `${f}: missing`);
        const others = [...engineFiles().filter((f) => !ITEM_FILES.includes(f)), ...codeFiles().filter((f) => !ITEM_FROZEN.includes(f) && f !== "src/engine-boundary-check.mjs")];
        return others.flatMap((f) => {
            const defined = ITEM_NAMES.filter((n) => definesOf(read(f)).has(n));
            return defined.length ? [`${f}: defines ${defined.join(", ")}`] : [];
        });
    },
    "15 process/items/ does not import the solvers": (read) => filesIn(ITEMS).flatMap((f) => {
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].filter((s) => SOLVERS.test(s) || SOLVERS.test(target(f, s)))
            .map((s) => `${f}: imports ${s}`);
    }),
    "16 process/rig/ never imports process/items/": (read) => filesIn(`${PROCESS}/rig`).flatMap((f) => {
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].filter((s) => target(f, s).startsWith(`${ITEMS}/`) || /(^|\/)items\//.test(s))
            .map((s) => `${f}: imports ${s}`);
    }),
    // Avatar parts get engine folders, step 4: body measuring and the body record
    "17 body measuring and the item measures import only three.js and their named engine files": (read) => Object.entries(MEASURING).flatMap(([f, allowed]) => {
        if (!existsSync(join(ENGINE, f))) return [`${f}: missing`];
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].filter((s) => !(s === "three" || allowed.includes(target(f, s))))
            .map((s) => `${f}: imports ${s}`);
    }),
    "18 nothing under process/ imports a node: module, a loader or the Node tools": (read) => filesIn(PROCESS).flatMap((f) => {
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].filter((s) => s.startsWith("node:") || LOADER.test(s) || LOADER.test(target(f, s)) || inTools(target(f, s)))
            .map((s) => `${f}: imports ${s}`);
    }),
    "19 nothing in the engine or under web/ imports the Node tools": (read) => [
        ...engineFiles().flatMap((f) => [...importsOf(read(f)), ...requiresOf(read(f)), ...resolvesOf(read(f))].filter((s) => inTools(target(f, s)) || /(^|\/)scene-core\/tools\//.test(s)).map((s) => `${f}: imports ${s}`)),
        ...codeFiles().filter((f) => f.startsWith("web/")).flatMap((f) => [...importsOf(read(f)), ...requiresOf(read(f))]
            .filter((s) => /(^|\/)scene-core\/tools\//.test(s) || (s.startsWith(".") && relative(CODE, resolve(CODE, dirname(f), s)).split("\\").join("/").startsWith("runtime/scene-core/tools/")))
            .map((s) => `${f}: imports ${s}`)),
    ],
    "20 a Node tool imports only node:, three.js, its own folder and process/": (read) => toolFiles().flatMap((f) => {
        const text = read(f);
        return [...importsOf(text), ...requiresOf(text), ...resolvesOf(text)].map((s) => [s, target(f, s)])
            .filter(([s, t]) => !(s.startsWith("node:") || /^three(\/|$)/.test(s) || (s.startsWith(".") && (t.startsWith(`${PROCESS}/`) || inTools(t)))))
            .map(([s]) => `${f}: imports ${s}`);
    }),
    "21 measureBody and gripError each exist once": (read) => {
        const missing = Object.entries(ONCE).filter(([name, f]) => !existsSync(join(ENGINE, f)) || !definesOf(read(f)).has(name)).map(([name, f]) => `${f}: does not define ${name}`);
        const others = [...engineFiles(), ...toolFiles(), ...codeFiles().filter((f) => f !== "src/engine-boundary-check.mjs")].filter((f) => !Object.values(ONCE).includes(f));
        return [...missing, ...others.flatMap((f) => {
            const defined = Object.keys(ONCE).filter((n) => definesOf(read(f)).has(n));
            return defined.length ? [`${f}: defines ${defined.join(", ")}`] : [];
        })];
    },
    // Avatar parts get engine folders, step 5: the motion driver and the movement model
    "22 nothing under animation/ or navigation/ imports a renderer file, the Scene Manager, an importer or a file outside the engine": (read) => MOVERS.flatMap(filesIn).flatMap((f) =>
        specifiersOf(read(f)).map((s) => [s, target(f, s)])
            .filter(([s, t]) => /^(render|render-adapter)\//.test(t) || RENDERER.files.includes(t) || t === MANAGER || t.startsWith("import/") || READER_FORWARDS.test(t)
                || t.startsWith("..") || s.startsWith("/") || s.startsWith("#") || /(^|\/)web\//.test(s))
            .map(([s]) => `${f}: imports ${s}`)),
    "23 animation/ imports nothing of navigation/, and navigation/ nothing of animation/": (read) => MOVERS.flatMap((dir) => {
        const other = MOVERS.find((d) => d !== dir);
        return filesIn(dir).flatMap((f) => specifiersOf(read(f)).filter((s) => target(f, s).startsWith(`${other}/`) || new RegExp(`(^|/)${other}/`).test(s))
            .map((s) => `${f}: imports ${s}`));
    }),
    "24 animation/drivers/humanoid/vendor/avatar-ik.mjs imports nothing": (read) => (existsSync(join(ENGINE, IK)) ? specifiersOf(read(IK)).map((s) => `${IK}: imports ${s}`) : [`${IK}: missing`]),
    "25 the motion driver, its fix-ups, its solver and the movement model exist once: no other file defines AvatarMotion, SolverStack, Locomotion, solveTwoBoneLeg or solveArmAvoid": (read) => {
        const present = MOVER_FILES.filter((f) => existsSync(join(ENGINE, f)));
        if (present.length < MOVER_FILES.length) return MOVER_FILES.filter((f) => !present.includes(f)).map((f) => `${f}: missing`);
        const others = [...engineFiles().filter((f) => !MOVER_FILES.includes(f)), ...codeFiles().filter((f) => !MOVER_FROZEN.includes(f) && f !== "src/engine-boundary-check.mjs")];
        const copies = others.flatMap((f) => {
            const text = read(f), defined = MOVER_NAMES.filter((n) => definesOf(text).has(n) || classesOf(text).has(n));
            return defined.length ? [`${f}: defines ${defined.join(", ")}`] : [];
        });
        const frozenUsed = codeFiles().filter((f) => !f.startsWith(MOVER_FROZEN_TREE)).flatMap((f) => [...importsOf(read(f)), ...requiresOf(read(f))]
            .filter((s) => s.startsWith(".")).map((s) => relative(CODE, resolve(CODE, dirname(f), s)).split("\\").join("/"))
            .filter((t) => MOVER_FROZEN.includes(t)).map((t) => `${f}: imports the frozen copy ${t}`));
        return [...copies, ...frozenUsed];
    },
    // Body measuring has its own folder: it reads the rig, clip, item and mesh code; none of those reads it.
    "26 process/body/ imports only three.js and process/rig/, clips/, items/, mesh/; none of those four imports process/body/": (read) => [
        ...filesIn(`${PROCESS}/body`).flatMap((f) => [...importsOf(read(f)), ...requiresOf(read(f)), ...resolvesOf(read(f))].map((s) => [s, target(f, s)])
            .filter(([s, t]) => !(s === "three" || /^process\/(rig|clips|items|mesh|body)\//.test(t))).map(([s]) => `${f}: imports ${s}`)),
        ...["rig", "clips", "items", "mesh"].flatMap((d) => filesIn(`${PROCESS}/${d}`)).flatMap((f) => [...importsOf(read(f)), ...requiresOf(read(f)), ...resolvesOf(read(f))]
            .filter((s) => target(f, s).startsWith(`${PROCESS}/body/`) || /(^|\/)body\//.test(s)).map((s) => `${f}: imports ${s}`)),
    ],
};

const RULE_10 = Object.keys(RULES).find((r) => r.startsWith("10 ")), RULE_11 = Object.keys(RULES).find((r) => r.startsWith("11 ")), RULE_12 = Object.keys(RULES).find((r) => r.startsWith("12 "));
const [RULE_13, RULE_14, RULE_15, RULE_16] = ["13 ", "14 ", "15 ", "16 "].map((n) => Object.keys(RULES).find((r) => r.startsWith(n)));
const [RULE_17, RULE_18, RULE_19, RULE_20, RULE_21] = ["17 ", "18 ", "19 ", "20 ", "21 "].map((n) => Object.keys(RULES).find((r) => r.startsWith(n)));
const [RULE_22, RULE_23, RULE_24, RULE_25] = ["22 ", "23 ", "24 ", "25 "].map((n) => Object.keys(RULES).find((r) => r.startsWith(n)));
const RULE_26 = Object.keys(RULES).find((r) => r.startsWith("26 "));
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
    { rule: "6 scene/manager.mjs names no format and imports no importer", edit: append(MANAGER, 'const preferred = "gltf";') },
    { rule: "7 the Scene, Interaction and Physics import no renderer file", edit: append("interaction/sensors.mjs", 'import { createSceneView } from "../render/three/scene-view.mjs";') },
    { rule: "8 on the document route only the Renderer calls bindSkin, setSkinPose or disposeSkin", edit: { [CONTROLLER]: readFileSync(join(CODE, CONTROLLER), "utf8")
        .replace(ROUTE_BLOCK[1], `adapter.setSkinPose(binding, pose);\n  ${ROUTE_BLOCK[1]}`) } },
    { rule: "9 no engine file imports the garment processor", edit: append("scene/scene.mjs", 'import { loadSkinned } from "../../../../fitting/garments/skinned.mjs";') },
    { rule: RULE_10, edit: append("process/rig/rig.mjs", 'import { createSceneView } from "../../render/three/scene-view.mjs";') },
    { rule: RULE_10, edit: append("process/rig/roles.mjs", 'const manager = await import("../../scene/manager.mjs");') },
    { rule: RULE_10, edit: append("process/rig/rig.mjs", 'import { gltfImporter } from "../../import/gltf/to-scene.mjs";') },
    { rule: RULE_10, edit: append("process/rig/rig.mjs", 'import { fitHold } from "../../../../../web/avatar/runtime/fitting/holds.mjs";') },
    { rule: RULE_11, edit: { "web/avatar/runtime/fitting/rig.mjs": readFileSync(join(ENGINE, "process/rig/rig.mjs"), "utf8") } },
    { rule: RULE_11, edit: { "scene/check.mjs": `${readFileSync(join(ENGINE, "scene/check.mjs"), "utf8")}\n${readFileSync(join(ENGINE, "process/rig/roles.mjs"), "utf8")}` } },
    { rule: RULE_11, edit: { "web/avatar/actionforge-avatar.mjs": `${readFileSync(join(CODE, "web/avatar/actionforge-avatar.mjs"), "utf8")}\nimport { detectRig } from "../vendor/avatar-evaluator-v1/fitting/roles.mjs";` } },
    { rule: RULE_10, edit: append("process/clips/map-clips.mjs", 'import { createSceneView } from "../../render/three/scene-view.mjs";') },
    { rule: RULE_10, edit: append("process/clips/map-clips.mjs", 'const manager = await import("../../scene/manager.mjs");') },
    { rule: RULE_10, edit: append("process/clips/map-clips.mjs", 'import { fitHold } from "../../../../../web/avatar/runtime/fitting/holds.mjs";') },
    { rule: RULE_11, edit: { "web/avatar/runtime/fitting/map-clips.mjs": readFileSync(join(ENGINE, "process/clips/map-clips.mjs"), "utf8") } },
    { rule: RULE_11, edit: { "web/avatar/runtime/clip-library.mjs": `${readFileSync(join(CODE, "web/avatar/runtime/clip-library.mjs"), "utf8")}\nimport { mapPoseAt } from "../../vendor/avatar-evaluator-v1/fitting/map-clips.mjs";` } },
    { rule: RULE_12, edit: append("process/clips/map-clips.mjs", 'import { check } from "../../scene/check.mjs";') },
    { rule: RULE_12, edit: append("process/clips/map-clips.mjs", 'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";') },
    { rule: RULE_12, edit: append("process/rig/rig.mjs", 'import { mapClip } from "../clips/map-clips.mjs";') },
    { rule: RULE_10, edit: append("process/items/placement.mjs", 'import { createSceneView } from "../../render/three/scene-view.mjs";') },
    { rule: RULE_10, edit: append("process/items/holds.mjs", 'const manager = await import("../../scene/manager.mjs");') },
    { rule: RULE_10, edit: append("process/items/placement.mjs", 'import { Equipment } from "../../../../../web/avatar/runtime/equipment.mjs";') },
    { rule: RULE_13, edit: append("process/items/placement.mjs", "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';") },
    { rule: RULE_14, edit: { "web/avatar/runtime/fitting/holds.mjs": readFileSync(join(ENGINE, "process/items/holds.mjs"), "utf8") } },
    { rule: RULE_14, edit: { "web/avatar/runtime/equipment.mjs": `${readFileSync(join(CODE, "web/avatar/runtime/equipment.mjs"), "utf8")}\nfunction itemRecord() {}` } },
    { rule: RULE_14, edit: { "scene/check.mjs": `${readFileSync(join(ENGINE, "scene/check.mjs"), "utf8")}\nexport const fitFace = () => null;` } },
    { rule: RULE_15, edit: append("process/items/placement.mjs", "import { SolverStack } from '../../../../../web/avatar/runtime/fitting/solvers.mjs';") },
    { rule: RULE_16, edit: append("process/rig/rig.mjs", "import { backAnchor } from '../items/holds.mjs';") },
    { rule: RULE_17, edit: append("process/body/body-details.mjs", "import { itemRecord } from '../items/placement.mjs';") },
    { rule: RULE_17, edit: append("process/items/measures.mjs", "import { mapPoseAt } from '../clips/map-clips.mjs';") },
    { rule: RULE_18, edit: append("process/body/body-details.mjs", "import { readFileSync } from 'node:fs';") },
    { rule: RULE_18, edit: append("process/items/measures.mjs", "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';") },
    { rule: RULE_18, edit: append("process/body/body-details.mjs", "import { loadGlbScene } from '../../../tools/node-context.mjs';") },
    { rule: RULE_19, edit: append("scene/check.mjs", "import { makeInPlace } from '../../tools/in-place.mjs';") },
    { rule: RULE_19, edit: { "web/avatar/runtime/equipment.mjs": `${readFileSync(join(CODE, "web/avatar/runtime/equipment.mjs"), "utf8")}\nimport { makeInPlace } from '../../../runtime/scene-core/tools/in-place.mjs';` } },
    { rule: RULE_20, edit: append("../tools/measure-body.mjs", "import { Equipment } from '../../../web/avatar/runtime/equipment.mjs';") },
    { rule: RULE_20, edit: append("../tools/node-context.mjs", "import { createSceneManager } from '../public/scene/manager.mjs';") },
    { rule: RULE_21, edit: append("scene/check.mjs", "export function measureBody() {}") },
    { rule: RULE_21, edit: { "web/avatar/runtime/equipment.mjs": `${readFileSync(join(CODE, "web/avatar/runtime/equipment.mjs"), "utf8")}\nconst gripError = () => 0;` } },
    { rule: RULE_21, edit: append("../tools/in-place.mjs", "export const measureBody = () => null;") },
    { rule: RULE_22, edit: append("animation/drivers/humanoid/driver.mjs", 'import { createSceneView } from "../../../render/three/scene-view.mjs";') },
    { rule: RULE_22, edit: append("navigation/humanoid/locomotion.mjs", 'const manager = await import("../../scene/manager.mjs");') },
    { rule: RULE_22, edit: append("animation/drivers/humanoid/avatar-motion.mjs", 'import { gltfImporter } from "../../../import/gltf/to-scene.mjs";') },
    { rule: RULE_22, edit: append("animation/drivers/humanoid/driver.mjs", 'import { readEvaluatedAvatarPose } from "../../../../../../web/evaluated-avatar-pose.mjs";') },
    { rule: RULE_23, edit: append("animation/drivers/humanoid/driver.mjs", 'import { Locomotion } from "../../../navigation/humanoid/locomotion.mjs";') },
    { rule: RULE_23, edit: append("navigation/humanoid/locomotion.mjs", 'import { AvatarMotion } from "../../animation/drivers/humanoid/avatar-motion.mjs";') },
    { rule: RULE_24, edit: append(IK, 'import * as THREE from "three";') },
    { rule: RULE_25, edit: { "web/avatar/runtime/avatar-motion.mjs": readFileSync(join(ENGINE, "animation/drivers/humanoid/avatar-motion.mjs"), "utf8") } },
    { rule: RULE_25, edit: { "scene/check.mjs": `${readFileSync(join(ENGINE, "scene/check.mjs"), "utf8")}\nexport class SolverStack {}` } },
    { rule: RULE_25, edit: { "web/avatar/runtime/index.mjs": `${readFileSync(join(CODE, "web/avatar/runtime/index.mjs"), "utf8")}\nimport { Locomotion as Frozen } from "../../vendor/avatar-evaluator-v1/mannequin/web/avatar/locomotion.mjs";` } },
    { rule: RULE_26, edit: append("process/body/body-details.mjs", 'import { check } from "../../scene/check.mjs";') },
    { rule: RULE_26, edit: append("process/rig/rig.mjs", "import { measureBody } from '../body/body-details.mjs';") },
    { rule: RULE_26, edit: append("process/mesh/mesh-math.mjs", "import { measureBody } from '../body/body-details.mjs';") },
];
const faults = FAULTS.map(({ rule, edit }) => {
    const found = run(edit).find((r) => r.rule === rule).crossings;
    return { rule, file: Object.keys(edit)[0], caught: found.length > 0, by: found[0] ?? null };
});
const missed = faults.filter((f) => !f.caught).length;
console.log(JSON.stringify({ engine: relative(CODE, ENGINE) || ENGINE, rules: results.length, broken: broken.length, results,
    frozenCopies: codeFiles().filter((f) => FROZEN.some(({ copy }) => f.startsWith(copy))), faultsPlanted: faults.length, faultsCaught: faults.length - missed, faults }, null, 2));
console.log(`engine boundary: ${results.length - broken.length}/${results.length} rules hold${broken.length ? ` (broken: ${broken.map((b) => b.rule.split(" ")[0]).join(", ")})` : ""}; ${faults.length - missed} of ${faults.length} planted faults caught`);
process.exitCode = broken.length || missed ? 1 : 0;
