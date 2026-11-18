import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ThreeRenderAdapter } from "../runtime/scene-core/public/render-adapter/three-render-adapter.mjs";
import { OwnX3dRenderAdapter } from "../runtime/scene-core/public/x3d/own-x3d-render-adapter.mjs";

// Environment resource boundary on the actual adapter and the bundled 0.186.1
// engine. The renderer below records contract effects only; it proves texture
// ownership and material state, not PMREM output or pixels.
const THREE = await import(new URL("../runtime/scene-core/public/vendor/three/three.module.js", import.meta.url).href);
assert.equal(THREE.REVISION, "186");
class Renderer {
  constructor() { this.domElement = { style: {} }; this.shadowMap = {}; this.extensions = { has: name => Renderer.floatLinear && name === "OES_texture_float_linear" }; }
  getContext() { return {}; }
  setPixelRatio() {}
  setSize() {}
  render() {}
  dispose() { this.disposed = true; }
}
Renderer.floatLinear = false;
let built = 0;
class CountingDataTexture extends THREE.DataTexture {
  constructor(...args) { super(...args); built++; this.disposals = 0; this.addEventListener("dispose", () => this.disposals++); }
}
const ENGINE = { ...THREE, WebGLRenderer: Renderer, DataTexture: CountingDataTexture };
const mountTarget = () => ({ clientWidth: 64, clientHeight: 64, children: [], appendChild(node) { this.children.push(node); node.parentNode = this; }, removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; } });
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function controlledResolver() {
  const calls = new Map();
  const resolver = (uri, { signal } = {}) => new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, aborted: false };
    signal?.addEventListener("abort", () => { entry.aborted = true; });
    calls.set(uri, entry);
  });
  return { resolver, calls };
}
const rgba = (width, height, value = .25) => ({ kind: "equirect-linear-rgba", width, height, data: new Float32Array(width * height * 4).fill(value) });
const rgb = (width, height) => ({ kind: "equirect-linear-rgb", width, height, data: Float32Array.from({ length: width * height * 3 }, (_, i) => i / 10) });

async function freshAdapter(Adapter = ThreeRenderAdapter) {
  const adapter = new Adapter(ENGINE);
  adapter.mount(mountTarget(), { frameLoop: false });
  await adapter.ready();
  return adapter;
}
function addMaterials(adapter) {
  const standard = new THREE.MeshStandardMaterial(), physical = new THREE.MeshPhysicalMaterial();
  const ownEnv = new THREE.MeshStandardMaterial({ envMap: new THREE.Texture() }), basic = new THREE.MeshBasicMaterial();
  physical.envMapIntensity = .7;
  const geometry = new THREE.BoxGeometry();
  adapter.sceneRoot.add(new THREE.Mesh(geometry, standard), new THREE.Mesh(geometry, [physical, ownEnv]), new THREE.Mesh(geometry, basic));
  return { standard, physical, ownEnv, basic };
}

// Each scenario takes the lighting entry point and the adapter class so the
// negative controls can run the same assertions against in-memory mutants.
async function successScenario(apply, Adapter) {
  const adapter = await freshAdapter(Adapter);
  const { resolver, calls } = controlledResolver();
  assert.deepEqual(adapter.setEnvironmentResolver(resolver), { supported: true, resolver: true });
  const materials = addMaterials(adapter);
  const pending = apply(adapter, { environment: { asset: "env://studio", intensity: 2 } });
  assert.equal(pending.status, "loading");
  assert.equal(pending.environmentStatus, "loading");
  assert.equal(pending.supported, false);
  assert.ok(calls.has("env://studio"), "resolution starts synchronously");
  assert.equal(adapter.sceneRoot.environment, null, "nothing is installed before data arrives");
  assert.equal(materials.standard.envMapIntensity, 1, "intensity waits for the environment");
  calls.get("env://studio").resolve(rgb(4, 2));
  const outcome = await pending.environmentReady;
  assert.equal(outcome.status, "applied");
  const texture = adapter.sceneRoot.environment;
  assert.ok(texture instanceof CountingDataTexture);
  assert.equal(texture.mapping, THREE.EquirectangularReflectionMapping);
  assert.equal(texture.type, THREE.FloatType);
  assert.equal(texture.format, THREE.RGBAFormat);
  assert.equal(texture.colorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(texture.flipY, true);
  assert.equal(texture.magFilter, THREE.NearestFilter, "no float-linear extension falls back to nearest");
  assert.equal(texture.version > 0, true, "needsUpdate was set");
  assert.deepEqual([texture.image.width, texture.image.height, texture.image.data.length], [4, 2, 32]);
  assert.deepEqual(Array.from(texture.image.data.slice(0, 8)).map(v => Math.round(v * 10) / 10), [0, .1, .2, 1, .3, .4, .5, 1], "RGB is widened to RGBA");
  assert.equal(materials.standard.envMapIntensity, 2);
  assert.equal(materials.physical.envMapIntensity, 2);
  assert.equal(materials.ownEnv.envMapIntensity, 1, "own envMap is untouched");
  assert.equal(materials.basic.envMapIntensity, undefined);
  const settled = adapter._lightingResult;
  assert.equal(settled.status, "supported");
  assert.equal(settled.supported, true);
  assert.equal(settled.environmentStatus, "applied");
  const same = apply(adapter, { environment: { asset: "env://studio", intensity: .5 } });
  assert.equal(same.status, "supported", "same asset reuses the installed texture");
  assert.equal(adapter.sceneRoot.environment, texture);
  assert.equal(materials.standard.envMapIntensity, .5);
  assert.equal(materials.physical.envMapIntensity, .5);
  apply(adapter, { environment: { asset: "env://studio" } });
  assert.equal(materials.physical.envMapIntensity, .7, "removing intensity restores prior values");
  apply(adapter, { environment: { asset: "env://studio", intensity: 3 } });
  const cleared = apply(adapter, { environment: null });
  assert.equal(cleared.environmentStatus, "cleared");
  assert.equal(adapter.sceneRoot.environment, null);
  assert.equal(materials.standard.envMapIntensity, 1);
  assert.equal(materials.physical.envMapIntensity, .7);
  assert.equal(texture.disposals, 1);
  apply(adapter, { environment: null });
  assert.equal(texture.disposals, 1, "double clear is safe");
  adapter.dispose();
  assert.equal(texture.disposals, 1);
}

async function replacementScenario(apply, Adapter) {
  const adapter = await freshAdapter(Adapter);
  const { resolver, calls } = controlledResolver();
  adapter.setEnvironmentResolver(resolver);
  const first = apply(adapter, { environment: { asset: "env://a" } });
  calls.get("env://a").resolve(rgba(2, 1));
  await first.environmentReady;
  const a = adapter.sceneRoot.environment;
  const second = apply(adapter, { environment: { asset: "env://b" } });
  assert.equal(adapter.sceneRoot.environment, a, "the old environment stays until the new one is ready");
  calls.get("env://b").resolve(rgba(2, 1, 1));
  await second.environmentReady;
  const b = adapter.sceneRoot.environment;
  assert.notEqual(b, a);
  assert.equal(a.disposals, 1, "replacement disposes the old texture once");
  assert.equal(b.disposals, 0);
  adapter.dispose();
  assert.equal(b.disposals, 1, "adapter disposal frees the owned texture");
  adapter.dispose();
  assert.equal(b.disposals, 1, "repeat disposal does not dispose again");
  assert.equal(a.disposals, 1);
}

async function staleScenario(apply, Adapter) {
  const adapter = await freshAdapter(Adapter);
  const { resolver, calls } = controlledResolver();
  adapter.setEnvironmentResolver(resolver);
  const old = apply(adapter, { environment: { asset: "env://old", intensity: 4 } });
  const fresh = apply(adapter, { environment: { asset: "env://new" } });
  assert.equal(calls.get("env://old").aborted, true, "the superseded request is aborted");
  calls.get("env://new").resolve(rgba(2, 1));
  assert.equal((await fresh.environmentReady).status, "applied");
  const installed = adapter.sceneRoot.environment;
  const before = built;
  calls.get("env://old").resolve(rgba(2, 1, 9));
  const outcome = await old.environmentReady;
  assert.equal(outcome.status, "discarded");
  assert.equal(adapter.sceneRoot.environment, installed, "a stale result is never installed");
  assert.equal(built, before, "a stale result never builds a texture");
  assert.equal(adapter._lightingResult.environmentStatus, "applied");
  adapter.dispose();
}

async function disposeScenario(apply, Adapter) {
  const adapter = await freshAdapter(Adapter);
  const { resolver, calls } = controlledResolver();
  adapter.setEnvironmentResolver(resolver);
  const first = apply(adapter, { environment: { asset: "env://kept" } });
  calls.get("env://kept").resolve(rgba(2, 1));
  await first.environmentReady;
  const kept = adapter.sceneRoot.environment;
  const pending = apply(adapter, { environment: { asset: "env://late" } });
  const scene = adapter.sceneRoot;
  adapter.dispose();
  assert.equal(kept.disposals, 1);
  assert.equal(scene.environment, null);
  assert.equal(calls.get("env://late").aborted, true);
  const before = built;
  calls.get("env://late").resolve(rgba(2, 1));
  assert.equal((await pending.environmentReady).status, "discarded", "a result after dispose is discarded");
  assert.equal(scene.environment, null);
  assert.equal(built, before);
  assert.throws(() => apply(adapter, { environment: { asset: "env://after" } }), /disposed/);
}

async function badDataScenario(apply, Adapter) {
  const adapter = await freshAdapter(Adapter);
  const { resolver, calls } = controlledResolver();
  adapter.setEnvironmentResolver(resolver);
  const materials = addMaterials(adapter);
  const first = apply(adapter, { environment: { asset: "env://good", intensity: 1.5 } });
  calls.get("env://good").resolve(rgba(2, 1));
  await first.environmentReady;
  const good = adapter.sceneRoot.environment;
  const bad = [
    ["nan", { ...rgba(2, 1), data: Float32Array.of(0, 0, 0, 1, NaN, 0, 0, 1) }, /not finite/],
    ["infinite", { ...rgb(1, 1), data: Float32Array.of(0, Infinity, 0) }, /not finite/],
    ["length", { ...rgba(2, 1), data: new Float32Array(7) }, /does not match/],
    ["width", { ...rgba(2, 1), width: 2.5 }, /positive integers/],
    ["height", { ...rgba(2, 1), height: 0 }, /positive integers/],
    ["kind", { ...rgba(2, 1), kind: "toString" }, /kind must be one of/],
    ["array", { ...rgba(2, 1), data: Array.from(new Float32Array(8)) }, /Float32Array/],
    ["empty", null, /must be an object/],
  ];
  for (const [name, image, reason] of bad) {
    const before = built;
    const request = apply(adapter, { environment: { asset: `env://bad-${name}`, intensity: 9 } });
    calls.get(`env://bad-${name}`).resolve(image);
    const outcome = await request.environmentReady;
    assert.equal(outcome.status, "failed", name);
    assert.match(outcome.reason, reason, name);
    assert.equal(built, before, `${name} builds no texture`);
    assert.equal(adapter.sceneRoot.environment, good, `${name} keeps the previous environment`);
    assert.equal(good.disposals, 0);
    assert.equal(materials.standard.envMapIntensity, 1.5, `${name} keeps the previous intensity`);
    const result = adapter._lightingResult;
    assert.equal(result.status, "limited");
    assert.equal(result.environmentStatus, "failed");
    assert.deepEqual(result.unsupported.map(entry => entry.setting), ["environment.asset", "environment.intensity"]);
  }
  const rejected = apply(adapter, { environment: { asset: "env://missing" } });
  calls.get("env://missing").reject(new Error("not found"));
  assert.match((await rejected.environmentReady).reason, /not found/);
  assert.equal(adapter.sceneRoot.environment, good);
  adapter.setEnvironmentResolver(() => { throw new Error("sync failure"); });
  const thrown = apply(adapter, { environment: { asset: "env://throws" } });
  assert.equal(thrown.status, "loading");
  assert.equal((await thrown.environmentReady).status, "failed");
  assert.equal(adapter._lightingResult.environmentStatus, "failed");
  assert.equal(adapter.sceneRoot.environment, good);
  assert.throws(() => apply(adapter, { environment: { asset: "env://x", intensity: -1 } }), /nonnegative/);
  assert.throws(() => apply(adapter, { environment: { asset: "env://x", intensity: NaN } }), /finite/);
  assert.throws(() => adapter.setEnvironmentResolver("https://example.invalid"), /function or null/);
  adapter.dispose();
  assert.equal(good.disposals, 1);
}

async function foreignScenario(apply, Adapter) {
  const adapter = await freshAdapter(Adapter);
  const { resolver, calls } = controlledResolver();
  adapter.setEnvironmentResolver(resolver);
  const foreign = new THREE.Texture();
  let foreignDisposals = 0;
  foreign.addEventListener("dispose", () => foreignDisposals++);
  adapter.sceneRoot.environment = foreign;
  apply(adapter, { environment: null });
  assert.equal(adapter.sceneRoot.environment, null, "clear removes the scene environment");
  assert.equal(foreignDisposals, 0, "a foreign environment is never disposed");
  const owned = apply(adapter, { environment: { asset: "env://own" } });
  calls.get("env://own").resolve(rgba(2, 1));
  await owned.environmentReady;
  const mine = adapter.sceneRoot.environment;
  adapter.sceneRoot.environment = foreign;
  adapter.dispose();
  assert.equal(adapter.sceneRoot.environment, foreign, "release leaves a host-installed environment in place");
  assert.equal(foreignDisposals, 0);
  assert.equal(mine.disposals, 1);
}

async function linearFilterScenario(apply, Adapter) {
  Renderer.floatLinear = true;
  try {
    const adapter = await freshAdapter(Adapter);
    const { resolver, calls } = controlledResolver();
    adapter.setEnvironmentResolver(resolver);
    const request = apply(adapter, { environment: { asset: "env://linear" } });
    calls.get("env://linear").resolve(rgba(2, 1));
    await request.environmentReady;
    assert.equal(adapter.sceneRoot.environment.magFilter, THREE.LinearFilter);
    adapter.dispose();
  } finally { Renderer.floatLinear = false; }
}

// No resolver: today's exact limited result, unchanged scene environment.
{
  const adapter = await freshAdapter();
  const existing = new THREE.Texture();
  adapter.sceneRoot.environment = existing;
  const result = adapter.setLighting({ environment: { asset: "/assets/environment.hdr", intensity: .5 } });
  assert.deepEqual(Object.keys(result), ["supported", "status", "unsupported", "environment", "shadows"]);
  assert.deepEqual(result.unsupported.map(entry => entry.setting), ["environment.asset", "environment.intensity"]);
  assert.equal(result.status, "limited");
  assert.equal(result.supported, false);
  assert.equal(adapter.sceneRoot.environment, existing);
  assert.throws(() => adapter.setLighting({ environment: new THREE.Texture() }), /neutral asset/);
  assert.equal(adapter.getCapabilities().features.environment.resolver, "supported");
  adapter.dispose();
}

const viaAdapter = (adapter, description) => adapter.setLighting(description);
const scenarios = { successScenario, replacementScenario, staleScenario, disposeScenario, badDataScenario, foreignScenario, linearFilterScenario };
for (const [name, scenario] of Object.entries(scenarios)) {
  try { await scenario(viaAdapter); }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}

// The owned X3D adapter overrides dispose() and releases the environment itself:
// once on the first dispose, never again on a second.
{
  const adapter = new OwnX3dRenderAdapter(ENGINE);
  const { resolver, calls } = controlledResolver();
  adapter.setEnvironmentResolver(resolver);
  const request = adapter.setLighting({ environment: { asset: "env://x3d" } });
  calls.get("env://x3d").resolve(rgba(2, 1));
  assert.equal((await request.environmentReady).status, "applied");
  const texture = adapter.sceneRoot.environment;
  assert.ok(texture instanceof CountingDataTexture);
  adapter.dispose();
  assert.equal(texture.disposals, 1, "owned X3D dispose releases the environment once");
  assert.equal(adapter.sceneRoot.environment, null);
  adapter.dispose();
  assert.equal(texture.disposals, 1, "a second owned X3D dispose does not release again");
}

// Negative controls: remove one guard in an in-memory copy of a product module
// and show the same scenario fails. No product file is edited. The adapter copy
// imports the features copy, so dispose() reaches the mutated release path.
const adapterDir = new URL("../runtime/scene-core/public/render-adapter/", import.meta.url);
const featuresSource = await readFile(new URL("three-render-features.mjs", adapterDir), "utf8");
const adapterSource = await readFile(new URL("three-render-adapter.mjs", adapterDir), "utf8");
const dataModule = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
async function mutant(find, replace, target = "features") {
  const source = target === "adapter" ? adapterSource : featuresSource;
  assert.equal(source.split(find).length, 2, `mutation target must occur once: ${find}`);
  const features = target === "features" ? featuresSource.replace(find, replace) : featuresSource;
  const adapter = (target === "adapter" ? adapterSource.replace(find, replace) : adapterSource)
    .replace(/from "(\.\/[^"]+)"/g, (_, specifier) => `from "${specifier === "./three-render-features.mjs" ? dataModule(features) : new URL(specifier, adapterDir).href}"`);
  assert.ok(!/from "\./.test(adapter));
  return (await import(dataModule(adapter))).ThreeRenderAdapter;
}
const controls = [
  ["stale-result guard removed", "    if (state.token !== token) return discarded;\n", "", staleScenario],
  ["replacement disposal removed", "    if (previous) releaseOwnedEnvironment(previous);\n", "", replacementScenario],
  ["foreign-environment guard removed", "  if (owned.scene.environment === owned.texture) owned.scene.environment = null;", "  owned.scene.environment = null;", foreignScenario],
  ["data validation removed", "      if (!Number.isFinite(value)) throw", "      if (false) throw", badDataScenario],
  ["dispose environment release removed", "        try { releaseThreeEnvironment(this); } catch (error) { environmentFailure = error; }\n", "", replacementScenario, "adapter"],
];
for (const [label, find, replace, scenario, target] of controls) {
  const Adapter = await mutant(find, replace, target);
  await assert.rejects(scenario(viaAdapter, Adapter), assert.AssertionError, `negative control did not fail: ${label}`);
  console.log(`negative control failed as expected: ${label}`);
}
// Without the release in dispose(), the owned texture stays installed and undisposed.
{
  const Adapter = await mutant(controls.at(-1)[1], "", "adapter");
  const adapter = await freshAdapter(Adapter);
  const { resolver, calls } = controlledResolver();
  adapter.setEnvironmentResolver(resolver);
  const request = adapter.setLighting({ environment: { asset: "env://leak" } });
  calls.get("env://leak").resolve(rgba(2, 1));
  await request.environmentReady;
  const texture = adapter.sceneRoot.environment;
  adapter.dispose();
  assert.equal(texture.disposals, 0, "the mutant leaks the owned texture");
  assert.equal(adapter.sceneRoot.environment, texture);
}
// The unmutated modules through the same copy path pass.
await staleScenario(viaAdapter, await mutant("// Neutral environment images", "// Neutral environment images"));
await replacementScenario(viaAdapter, await mutant("        this._disposed = true;\n", "        this._disposed = true;\n", "adapter"));

console.log(`render adapter environment: bundled r${THREE.REVISION}, ${Object.keys(scenarios).length} scenarios, the owned X3D release control and ${controls.length} negative controls passed`);
