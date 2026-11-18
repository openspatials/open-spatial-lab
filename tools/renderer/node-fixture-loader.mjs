// Node qualification uses the same engine bytes as the browser import map.
import { readFile } from "node:fs/promises";
const bundled = new URL("../../runtime/scene-core/public/vendor/three/three.module.js", import.meta.url).href;
const bundledCore = new URL("../../runtime/scene-core/public/vendor/three/three.core.js", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "three") return { url: bundled, shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === bundled || url === bundledCore) return { format: "module", source: await readFile(new URL(url), "utf8"), shortCircuit: true };
  return nextLoad(url, context);
}
