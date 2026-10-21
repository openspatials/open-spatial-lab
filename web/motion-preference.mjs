const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function createMotionPreference({ view = globalThis, target = null, mediaQueryList = null } = {}) {
  const preference = mediaQueryList || (typeof view?.matchMedia === "function"
    ? view.matchMedia(REDUCED_MOTION_QUERY)
    : null);
  const syncTarget = () => {
    if (target?.dataset) target.dataset.motion = preference?.matches === true ? "reduced" : "full";
  };
  const isReduced = () => preference?.matches === true;
  const addListener = preference?.addEventListener
    ? () => preference.addEventListener("change", syncTarget)
    : preference?.addListener
      ? () => preference.addListener(syncTarget)
      : null;
  const removeListener = preference?.removeEventListener
    ? () => preference.removeEventListener("change", syncTarget)
    : preference?.removeListener
      ? () => preference.removeListener(syncTarget)
      : null;
  let disposed = false;

  syncTarget();
  addListener?.();

  return Object.freeze({
    isReduced,
    dispose() {
      if (disposed) return;
      disposed = true;
      removeListener?.();
    },
  });
}
