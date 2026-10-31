/**
 * registry.mjs: the engines this copy knows, and the boot-time choice.
 *
 * After Nicholas Polys's RenderAdapter, npolys/open-spatial-lab (commit 99175b4b6).
 *
 * three.js is the default and draws through app.js. X3DOM and X_ITE draw through the separate
 * X3D boot path Nicholas built (web/x3dom-live-mode.mjs), so app.js never loads for them.
 */

import { assertRenderAdapterEntry, resolveRenderAdapter } from "./render-adapter.mjs";
import { ThreeRenderAdapter } from "./three-render-adapter.mjs";
import { X3DOMRenderAdapter } from "./x3dom-render-adapter.mjs";
import { XIteRenderAdapter } from "./x-ite-render-adapter.mjs";

export const RENDER_ADAPTER_CLASSES = Object.freeze({
  three: ThreeRenderAdapter,
  x3dom: X3DOMRenderAdapter,
  x_ite: XIteRenderAdapter,
});

export function createRenderAdapterRegistry(THREE) {
  const registry = {
    three: { ...ThreeRenderAdapter.info, version: `r${THREE.REVISION}`, adapter: new ThreeRenderAdapter(THREE) },
    x3dom: { ...X3DOMRenderAdapter.info },
    x_ite: { ...XIteRenderAdapter.info },
  };
  for (const entry of Object.values(registry)) assertRenderAdapterEntry(entry);
  return Object.freeze(registry);
}

/** Resolves ?renderer= against the registry for this copy. */
export function chooseRenderAdapter(THREE, search) {
  return resolveRenderAdapter(search, createRenderAdapterRegistry(THREE));
}
