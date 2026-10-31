// ?renderer=x_ite: the boot path Nicholas Polys built for X3DOM (web/x3dom-live-mode.mjs), driving an
// XIteRenderAdapter. X_ITE 16.6.0, MIT licence, by Holger Seelig and contributors.
import X3D from "./vendor/scene-core/vendor/x_ite/x_ite.min.mjs";
import { XIteRenderAdapter } from "./vendor/scene-core/render-adapter/x-ite-render-adapter.mjs";
import { runX3dLiveMode } from "./x3dom-live-mode.mjs";

const BANNER = "X_ITE preview: rooms, hosted objects, avatar, equipment, camera, walking, portal previews and crossing are real. " +
  "The airport has its building but no travelers. Avatars stand still.";

export function startLiveMode() {
  const host = document.getElementById("scene-mount");
  const adapter = new XIteRenderAdapter(X3D);
  adapter.mount(host, { camera: { fov: 50, near: 0.05, far: 300 } });
  return runX3dLiveMode({
    adapter,
    info: XIteRenderAdapter.info,
    bannerText: BANNER,
    dragEl: () => adapter.canvasElement,
    prepare: async () => { await adapter.ready(); },
  });
}
