export function requireActiveBoot(isDisposed) {
  if (isDisposed())
    throw Object.assign(new Error("application disposed during boot"), {
      name: "AbortError",
    });
}

/** Existing application owns cancellation and disposal; these phases only order adoption. */
export async function bootLive({
  adapter,
  sceneRuntime,
  isDisposed,
  prepareSession,
  createAvatar,
  sceneRole,
  isPlayer,
}) {
  requireActiveBoot(isDisposed);
  await adapter.init();
  requireActiveBoot(isDisposed);
  await prepareSession();
  requireActiveBoot(isDisposed);
  await sceneRuntime.mountLive({
    world: adapter.world,
    sceneRole: sceneRole(adapter.debugState()),
    phase: adapter.state.phase,
  });
  requireActiveBoot(isDisposed);
  const avatar = createAvatar();
  await avatar.ready;
  requireActiveBoot(isDisposed);
  if (isPlayer)
    avatar.setLocomotionTuningListener((tuning) =>
      adapter.setAvatarLocomotionTuning(tuning)
    );
  return { adapter, avatar };
}

export async function bootWow({ adapter, sceneRuntime, isDisposed, logLine }) {
  requireActiveBoot(isDisposed);
  let resolved = null,
    loadError = null;
  try {
    resolved = await adapter.initWow();
    requireActiveBoot(isDisposed);
    logLine(
      `M2 wow: graph spatialID=${resolved.spatialID} nodes=${resolved.node_count} source=${resolved.source}`
    );
  } catch (error) {
    requireActiveBoot(isDisposed);
    loadError = error?.message || String(error);
    logLine(`M2 wow: LOAD ERROR: ${loadError}`);
  }
  const mounted = await sceneRuntime.mountWowGraph(resolved, loadError);
  requireActiveBoot(isDisposed);
  return { resolved, loadError, ...mounted };
}
