/** Shared frame policy. LiveAdapter remains the authority for world, access and network state. */
export function createApplicationCore({ readRuntime, readLayers, readScene, stepInput, updateView, drawPreviews, publishFrame, requestFrame, cancelFrame, now = () => performance.now(), onError = error => { throw error; } }) {
  let running = false;
  let disposed = false;
  let pending = null;
  let previous = null;
  let frames = 0;
  let generation = 0;
  const schedule = () => {
    const scheduledGeneration = generation;
    pending = requestFrame(timestamp => frame(timestamp, scheduledGeneration));
  };
  const frame = (timestamp, frameGeneration) => {
    if (!running || disposed || frameGeneration !== generation) return;
    pending = null;
    const active = () => running && !disposed && frameGeneration === generation;
    const delta = previous == null ? 0 : Math.min(.05, Math.max(0, (timestamp - previous) / 1000));
    previous = timestamp;
    try {
      const runtime = readRuntime();
      if (!active()) return;
      stepInput(runtime, delta, timestamp);
      if (!active()) return;
      const layers = readLayers();
      if (!active()) return;
      for (const layer of [layers.local, ...layers.peers].filter(Boolean)) {
        layer.evaluateFrame?.(delta);
        if (!active()) return;
      }
      updateView(runtime, delta, timestamp);
      if (!active()) return;
      const scene = readScene();
      if (!active()) return;
      scene?.evaluateFrame?.(delta);
      if (!active()) return;
      publishFrame?.(runtime, layers, timestamp);
      if (!active()) return;
      drawPreviews(runtime, timestamp, delta);
      if (!active()) return;
      scene?.renderFrame?.(timestamp);
      if (!active()) return;
      frames += 1;
    } catch (error) { if (active()) onError(error, timestamp); }
    finally { if (active() && pending == null) schedule(); }
  };
  return Object.freeze({
    start() {
      if (disposed) throw new Error("application core disposed");
      if (running) return false;
      running = true;
      generation += 1;
      previous = now();
      schedule();
      return true;
    },
    stop() {
      if (!running) return false;
      running = false;
      generation += 1;
      if (pending != null) cancelFrame(pending);
      pending = null;
      return true;
    },
    snapshot() {
      const runtime = readRuntime();
      return { world: runtime?.world || null, state: runtime?.state || null, frames, running, disposed, scheduledFrames: pending == null ? 0 : 1 };
    },
    dispose() {
      running = false;
      disposed = true;
      generation += 1;
      if (pending != null) cancelFrame(pending);
      pending = null;
    },
  });
}
