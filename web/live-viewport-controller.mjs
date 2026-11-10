import { pixelRatioFor } from "./render-quality-levers.mjs";

function bounds(element) {
  if (!element) return null;
  const rectangle = element.getBoundingClientRect();
  return Object.fromEntries(["left", "top", "width", "height"].map(key => [key, Number(rectangle[key].toFixed(3))]));
}

function measure(windowTarget) {
  const visual = windowTarget.visualViewport, root = windowTarget.document.documentElement;
  return {
    width: Math.max(1, Number(visual?.width || windowTarget.innerWidth || root.clientWidth || 1)),
    height: Math.max(1, Number(visual?.height || windowTarget.innerHeight || root.clientHeight || 1)),
    offsetLeft: Number(visual?.offsetLeft || 0), offsetTop: Number(visual?.offsetTop || 0),
    pixelRatio: pixelRatioFor(windowTarget.devicePixelRatio),
  };
}

function publish(documentTarget, viewport) {
  const style = documentTarget.documentElement.style;
  style.setProperty("--osl-viewport-width", `${viewport.width}px`);
  style.setProperty("--osl-viewport-height", `${viewport.height}px`);
  style.setProperty("--osl-viewport-left", `${viewport.offsetLeft}px`);
  style.setProperty("--osl-viewport-top", `${viewport.offsetTop}px`);
  documentTarget.body.setAttribute("data-live-viewport-epoch", String(viewport.epoch));
}

export function createLiveViewportController({ windowTarget, mount: app, sceneRuntime, requestFrame, cancelFrame, onResize }) {
  const documentTarget = windowTarget.document;
  const state = { width: 0, height: 0, offsetLeft: 0, offsetTop: 0, pixelRatio: 1, epoch: 0, listenerCount: 0 };
  const removers = [];
  let mounted = false, disposed = false, frame = null, removePixelRatio = null;

  function snapshot() {
    return { ...state, root: bounds(documentTarget.documentElement), body: bounds(documentTarget.body), app: bounds(app),
      scene_mount: bounds(documentTarget.getElementById("scene-mount")),
      page_scroll_width: documentTarget.documentElement.scrollWidth, page_scroll_height: documentTarget.documentElement.scrollHeight,
      scene: sceneRuntime ? sceneRuntime.viewportDebug() : null };
  }
  function resize({ force = false } = {}) {
    if (disposed) return snapshot();
    const next = measure(windowTarget);
    const changed = Object.keys(next).some(key => Math.abs(next[key] - state[key]) > 0.01);
    if (!changed && !force) return snapshot();
    Object.assign(state, next, { epoch: state.epoch + 1 });
    publish(documentTarget, state);
    sceneRuntime?.resize(next); onResize?.();
    return snapshot();
  }
  function schedule() {
    if (disposed || frame !== null) return;
    frame = requestFrame(() => { frame = null; if (!disposed) resize(); });
  }
  function armPixelRatio() {
    removePixelRatio?.(); removePixelRatio = null;
    const matchMedia = windowTarget["match" + "Media"];
    if (typeof matchMedia !== "function") return;
    const query = matchMedia.call(windowTarget, `(resolution: ${Number(windowTarget.devicePixelRatio) || 1}dppx)`);
    const changed = () => { if (!disposed) { armPixelRatio(); schedule(); } };
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", changed, { once: true });
      removePixelRatio = () => query.removeEventListener("change", changed);
    } else if (typeof query.addListener === "function") {
      query.addListener(changed); removePixelRatio = () => query.removeListener(changed);
    }
  }
  function mount() {
    if (mounted || disposed) return false;
    mounted = true;
    for (const [target, type] of [[windowTarget, "resize"], [windowTarget, "orientationchange"], [windowTarget.visualViewport, "resize"], [windowTarget.visualViewport, "scroll"]]) {
      if (!target) continue;
      target.addEventListener(type, schedule, { passive: true });
      removers.push(() => target.removeEventListener(type, schedule));
    }
    armPixelRatio(); state.listenerCount = removers.length + (removePixelRatio ? 1 : 0);
    resize({ force: true }); return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancelFrame(frame);
    frame = null; removePixelRatio?.(); removePixelRatio = null;
    for (const remove of removers.splice(0)) remove();
    state.listenerCount = 0;
  }
  return Object.freeze({ mount, resize, schedule, snapshot, dispose });
}
