export function snapshotVisualState(state, snapshotAvatar) {
  return {
      ...state,
      avatar: snapshotAvatar(state.avatar),
      controls: { ...(state.controls || {}) },
      preview: state.preview,
      portal_previews: state.portal_previews,
      equipment_status: state.equipment_status,
    };
}

export function visualRuntimeProjection(staged, live) {
    if (!staged) {
      return {
        staged: false,
        metadata: null,
        state: live.state,
        world: live.world,
        base: live.base,
        activeEndpointKey: live.activeEndpointKey,
        previewEndpointKey: live.previewEndpointKey,
      };
    }
    return {
      staged: true,
      metadata: { ...staged.metadata },
      state: staged.state,
      world: staged.world,
      base: staged.base,
      activeEndpointKey: staged.activeEndpointKey,
      previewEndpointKey: staged.previewEndpointKey,
    };
}

export function visualDebugProjection(staged, raw) {
    if (!staged) return raw;
    return {
      ...staged.sourceDebug,
      active: staged.activeDebug,
      preview: staged.previewDebug,
      portal_previews: staged.state.portal_previews || null,
      location_id: staged.world.location_id,
      world_id: staged.world.world_id,
      session_id: staged.world.session_id,
      phase: staged.state.phase,
      handoff_id: staged.state.handoff_id,
      session: { arrival_count: staged.state.arrival_count },
      avatar: staged.state.avatar,
      controls: staged.state.controls,
      equipment_status: staged.state.equipment_status,
      claim_boundary: staged.world.claim_boundary,
      visual_transition: {
        staged: true,
        metadata: { ...staged.metadata },
        staged_at: staged.staged_at,
      },
    };
}

export function restoreVisualState(state, staged, snapshotAvatar) {
      let restoredAvatar = staged.state.avatar;
      if (staged.liveAvatar && staged.state.avatar) {
        restoredAvatar = staged.liveAvatar;
        for (const key of Object.keys(restoredAvatar)) delete restoredAvatar[key];
        Object.assign(restoredAvatar, snapshotAvatar(staged.state.avatar));
      }
      let restoredControls = { ...(staged.state.controls || {}) };
      if (staged.liveControls) {
        restoredControls = staged.liveControls;
        for (const key of Object.keys(restoredControls)) delete restoredControls[key];
        Object.assign(restoredControls, staged.state.controls || {});
      }
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, staged.state, {
        avatar: restoredAvatar,
        controls: restoredControls,
      });
}
