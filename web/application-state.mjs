import { describeScene } from "#scene-description";
import { hostedAccessOf } from "./hosted-access-label.mjs";
import { airportSceneContract } from "./airport-lobby-transition.mjs";
import { airportSurfaceBounds } from "./airport-walkable-surface.mjs";
/** Rendering-free application state and intent. LiveAdapter owns protocol/state
 * transitions; every consumer sees its same committed visual projection. */
export function createApplicationState({ getAdapter, readRefresh = () => null }) {
  let disposed = false;
  let equipmentGeneration = 0;
  let compositionGeneration = 0;
  let pendingComposition = null;
  let clientSceneInFlight = false;
  let clientGeneration = 0;
  let cancelClientScene = null;
  const adapter = () => disposed ? null : getAdapter();
  const retired = () => Object.assign(new Error("application composition retired"), { name: "AbortError" });

  function cancelComposition() {
    compositionGeneration += 1;
    pendingComposition?.cancel();
    pendingComposition = null;
  }

  /** Renderer preparation may mount a private surface, but constructs no world
   * until its existing adapter readiness contract settles. */
  async function composeScene({ prepare, construct }) {
    if (disposed) throw retired();
    cancelComposition();
    const generation = compositionGeneration;
    const live = adapter();
    const prepared = prepare();
    let released = false;
    const release = () => { if (!released) { released = true; prepared.dispose(); } };
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => { release(); reject(retired()); }; });
    const task = { cancel };
    pendingComposition = task;
    const assertCurrent = () => {
      if (disposed || generation !== compositionGeneration || adapter() !== live) throw retired();
    };
    try {
      await Promise.race([prepared.ready(), cancelled]);
      assertCurrent();
      const result = construct(prepared.handle, assertCurrent);
      assertCurrent();
      return result;
    } catch (error) {
      release();
      throw error;
    } finally {
      if (pendingComposition === task) pendingComposition = null;
    }
  }

  function clientSceneEntry(target, resolved, facts) {
    const contract = airportSceneContract(resolved.graph, target);
    if (!contract) throw new Error("airport graph did not satisfy client scene load contract");
    if (!facts?.entry_ground?.ok) throw new Error("airport scene has no authoritative walkable entry ground");
    contract.entry_spawn.position[1] = facts.entry_ground.surface_y_m;
    const bounds = airportSurfaceBounds(facts.surfaces);
    return { target, resolved, contract, bounds };
  }

  /** App transaction ordering; LiveAdapter's existing client-scene controller
   * remains the state/identity owner. The renderer returns only ground facts
   * and a handle that the application does not inspect. */
  async function loadClientScene(target, renderer) {
    if (disposed) throw retired();
    if (clientSceneInFlight) throw new Error("client scene load already in flight");
    const live = adapter();
    if (!live) throw new Error("client scene load requires the live player adapter");
    const generation = ++clientGeneration;
    clientSceneInFlight = true;
    let prepared = null;
    let released = false;
    const releasePrepared = () => { if (prepared && !released) { released = true; prepared.dispose(); } };
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => { releasePrepared(); reject(retired()); }; });
    cancelClientScene = cancel;
    let began = false;
    let committing = false;
    const isCurrent = () => !disposed && generation === clientGeneration && adapter() === live && renderer.isCurrent();
    const assertCurrent = () => { if (!isCurrent()) throw retired(); };
    try {
      if (target?.transition === "client_scene_return") {
        live.beginVisualTransition?.({ kind: "client_scene_return", source_location_id: live.world.location_id, target_location_id: target.spatial_id });
        began = true;
        const returned = await Promise.race([live.returnFromClientSceneLoad({ reciprocalPortalId: target.portal_id, isCurrent }), cancelled]);
        assertCurrent();
        if (!returned.ok) throw new Error(returned.reason || "client scene return failed");
        return returned;
      }
      const resolved = await Promise.race([live.resolveClientSceneLoad(target), cancelled]);
      assertCurrent();
      if (!airportSceneContract(resolved.graph, target)) throw new Error("airport graph did not satisfy client scene load contract");
      const preparing = Promise.resolve(renderer.prepare(resolved)).then(value => {
        prepared = value;
        if (!isCurrent()) { releasePrepared(); throw retired(); }
        return value;
      });
      await Promise.race([preparing, cancelled]);
      assertCurrent();
      const entry = clientSceneEntry(target, resolved, prepared.walkable);
      live.beginVisualTransition?.({ kind: "client_scene_load", source_location_id: live.world.location_id, target_location_id: target.spatial_id });
      began = true;
      assertCurrent();
      const entered = await Promise.race([live.enterClientSceneLoad({ ...entry, isCurrent }), cancelled]);
      assertCurrent();
      if (!entered.ok) throw new Error(entered.reason || "client scene load refused");
      live.commitVisualTransition?.({ emit: true });
      assertCurrent();
      committing = true;
      return renderer.commit(prepared.handle, { ...entry, entered });
    } catch (error) {
      releasePrepared();
      if (disposed || generation !== clientGeneration || adapter() !== live || (!committing && !renderer.isCurrent())) throw error;
      if (began) {
        if (live.debugState()?.client_scene_load?.active) await live.returnFromClientSceneLoad();
        else await renderer.rollback();
        live.abortVisualTransition?.({ restore: false });
      }
      throw error;
    } finally {
      if (cancelClientScene === cancel) cancelClientScene = null;
      clientSceneInFlight = false;
    }
  }
  const snapshot = () => {
    const live = adapter();
    if (!live) return null;
    return live.visualRuntimeSnapshot?.() || {
      staged: false, state: live.state, world: live.world, base: live.base,
      activeEndpointKey: live.activeEndpointKey, previewEndpointKey: live.previewEndpointKey,
    };
  };
  const debugState = () => {
    const live = adapter();
    return live?.visualDebugState?.() || live?.debugState() || null;
  };
  const runtime = () => {
    const live = adapter();
    const visual = snapshot();
    if (!live || !visual) return null;
    return {
      state: visual.state, world: visual.world, base: visual.base,
      phase: () => visual.state.phase,
      avatar: () => visual.state.avatar,
      debugState,
      rawDebugState: () => live.debugState(),
      isHandoffInFlight: () => live._portalTraversalController?.inFlight?.() === true,
      controlledPlayerId: () => live.controlledIdentity().player_id,
      stepAvatar: (input, dt) => live.stepAvatar(input, dt),
      shouldAutoHandoff: () => live.shouldAutoHandoff(),
      markAutoHandoffObserved: () => live.markAutoHandoffObserved(),
      broadcastPlayerPose: options => live.broadcastPlayerPose(options),
      childFabricManifest: () => live.childFabricManifest(),
      setChildFabricRenderState: state => live.setChildFabricRenderState(state),
      markChildFabricPreviewFrame: () => live.markChildFabricPreviewFrame(),
      notifyFabricChunkRendered: (key, count) => live.notifyFabricChunkRendered(key, count),
      wowResolved: () => live.wowResolved(),
      resolveClientSceneLoad: target => live.resolveClientSceneLoad(target),
      resolvePortalDestinationContent: entry => live.resolvePortalDestinationContent(entry),
      enterClientSceneLoad: payload => live.enterClientSceneLoad(payload),
      returnFromClientSceneLoad: options => live.returnFromClientSceneLoad(options),
      beginVisualTransition: metadata => live.beginVisualTransition(metadata),
      commitVisualTransition: options => live.commitVisualTransition(options),
      abortVisualTransition: options => live.abortVisualTransition(options),
    };
  };
  const selection = () => {
    const live = adapter();
    if (!live) return null;
    return {
      avatar: live.state?.avatar, world: live.world,
      setAvatarVariant: variant => live.setAvatarVariant(variant),
      setPreferredHeight: height => live.setPreferredHeight(height),
      async applyEquipment(items, resolveStatus) {
        const avatar = live.state?.avatar;
        if (!avatar) return { ok: false, error: "no embodied avatar" };
        const generation = ++equipmentGeneration;
        avatar.equippedItems = items;
        const status = await resolveStatus(items);
        if (disposed || generation !== equipmentGeneration || adapter() !== live || live.state?.avatar !== avatar)
          return { ok: false, error: "equipment selection retired" };
        live.state.equipment_status = status;
        live.broadcastPlayerPose({ force: true });
        live._emit();
        return { ok: true };
      },
    };
  };
  return Object.freeze({
    snapshot, debugState, runtime, selection, composeScene, cancelComposition, loadClientScene,
    clientSceneLoadInFlight: () => clientSceneInFlight,
    settings: () => ({ refresh: readRefresh() }),
    // World/room/object identities, access labels and destinations stay in the
    // canonical world description. Renderer implementations cannot rewrite it.
    sceneDescription: (overrides = {}) => {
      const visual = snapshot();
      return describeScene({ world: visual?.world, avatar: visual?.state?.avatar, phase: visual?.state?.phase,
        graph: adapter()?.wowResolved?.()?.graph || null, ...overrides });
    },
    describeObjects: objects => (objects || []).map(definition => ({ ...definition, asset_access: hostedAccessOf(definition) })),
    dispose() { disposed = true; equipmentGeneration += 1; clientGeneration += 1; cancelClientScene?.(); cancelComposition(); },
  });
}
