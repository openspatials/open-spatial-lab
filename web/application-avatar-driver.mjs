function readPeerAvatars(peerAvatarLayers) {
  return Array.from(peerAvatarLayers().entries()).map(([clientId, layer]) => ({
    client_id: clientId,
    player_id: layer && layer.__peerPlayerId ? layer.__peerPlayerId : clientId,
    rendered: !!(layer && layer.avatarRig && layer.avatarRig.visible),
    settled:
      layer && typeof layer.isSettled === "function" ? layer.isSettled() : null,
    position:
      layer && layer.avatarRig
        ? [
            Number(layer.avatarRig.position.x.toFixed(4)),
            Number(layer.avatarRig.position.y.toFixed(4)),
            Number(layer.avatarRig.position.z.toFixed(4)),
          ]
        : null,
    rotation_y:
      layer && layer.avatarRig
        ? Number(layer.avatarRig.rotation.y.toFixed(6))
        : null,
    avatar_variant: layer && layer.status ? layer.status.avatar_variant : null,
    // The peer's user label (name and pilot), and whether it is drawn on the avatar.
    label:
      layer && layer.__peerLabel
        ? { text: layer.__peerLabel, drawn: !!(layer.avatarRig && layer.avatarRig.getObjectByName("peer-label")) }
        : null,
    visual_separation: layer ? layer.__peerVisualSeparation || null : null,
    attached_item_count:
      layer && typeof layer.debugState === "function"
        ? layer.debugState().attached_item_count
        : null,
  }));
}

function readDepthLayers(getEquipmentLayer, peerAvatarLayers) {
  const firstPeer = peerAvatarLayers().values().next().value || null;
  return {
    local: getEquipmentLayer() ? getEquipmentLayer().avatarRig : null,
    peer: firstPeer ? firstPeer.avatarRig : null,
    same_renderer:
      !!getEquipmentLayer() &&
      !!firstPeer &&
      getEquipmentLayer().renderer === firstPeer.renderer,
    same_scene:
      !!getEquipmentLayer() &&
      !!firstPeer &&
      getEquipmentLayer().scene === firstPeer.scene,
    local_canvas:
      getEquipmentLayer() && getEquipmentLayer().renderer
        ? getEquipmentLayer().renderer.domElement
        : null,
    peer_canvas:
      firstPeer && firstPeer.renderer ? firstPeer.renderer.domElement : null,
  };
}

function readAvatarVisualState(getEquipmentLayer) {
  return getEquipmentLayer()
    ? {
        avatar_variant: getEquipmentLayer().status.avatar_variant,
        avatar_variant_label: getEquipmentLayer().status.avatar_variant_label,
        avatar_switch_count: getEquipmentLayer().status.avatar_switch_count,
        avatar_switch_in_flight:
          getEquipmentLayer().status.avatar_switch_in_flight,
        avatar_model_height_m: getEquipmentLayer().status.avatar_model_height_m,
        avatar_head_height_m: getEquipmentLayer().status.avatar_head_height_m,
        attached_items: getEquipmentLayer().status.attachedItems,
        locomotion_clips: getEquipmentLayer().status.locomotion_clips,
        current_animation_state:
          getEquipmentLayer().status.current_animation_state,
        animation_runtime: getEquipmentLayer().status.animation_runtime || null,
        avatar_render_source:
          getEquipmentLayer().status.avatar_render_source || null,
        locomotion_tuning: getEquipmentLayer().status.locomotion_tuning || null,
        motion_weights: getEquipmentLayer().motionWeights
          ? getEquipmentLayer().motionWeights()
          : null,
        errors: (getEquipmentLayer().status.errors || []).slice(-5),
        run_calibration: { ...getEquipmentLayer().status.run_calibration },
      }
    : null;
}

function scanEquipmentScene(getEquipmentLayer, peerAvatarLayers) {
  if (!getEquipmentLayer() || !getEquipmentLayer().avatarRig) return null;
  const out = {
    marker_groups: 0,
    marker_meshes: 0,
    wide_bar_meshes: 0,
    wide_bar_names: [],
  };
  const underMarker = (node) => {
    for (let p = node; p; p = p.parent) {
      if (p.name && p.name.startsWith("visible-equipment-marker-")) return true;
    }
    return false;
  };
  getEquipmentLayer().avatarRig.traverse((node) => {
    if (node.name && node.name.startsWith("visible-equipment-marker-"))
      out.marker_groups += 1;
    if (!node.isMesh) return;
    if (underMarker(node)) out.marker_meshes += 1;
    const params =
      node.geometry && node.geometry.parameters
        ? node.geometry.parameters
        : null;
    if (params && Number(params.width) >= 0.5) {
      out.wide_bar_meshes += 1;
      out.wide_bar_names.push(
        node.name || (node.parent && node.parent.name) || "unnamed"
      );
    }
  });
  return out;
}

export function avatarDriver(readers, owners) {
  const { adapter, avatarSelectorController } = owners;
  const { getEquipmentLayer, peerAvatarLayers } = readers;
  return {
    equipmentReady: () =>
      !getEquipmentLayer() || getEquipmentLayer().isSettled(),
    peerAvatars: () => readPeerAvatars(peerAvatarLayers),
    peerAvatarCount: () => peerAvatarLayers().size,
    switchAvatar: (variant) =>
      variant
        ? adapter.setAvatarVariant(variant)
        : adapter.toggleAvatarVariant(),
    equipItem: (itemId) => adapter.equipCatalogItem(itemId),
    equippableCatalog: () => adapter.equippableCatalog(),
    avatarSelector: {
      ...avatarSelectorController.selectorDriver(),
      removeAllEquipment: () => avatarSelectorController.removeAllEquipment(),
    },
    inventory: avatarSelectorController.inventoryDriver(),
    equipmentSceneScan: () =>
      scanEquipmentScene(getEquipmentLayer, peerAvatarLayers),

    __depthProbeLayers: () =>
      readDepthLayers(getEquipmentLayer, peerAvatarLayers),

    rigProbe: () =>
      getEquipmentLayer() ? getEquipmentLayer().rigProbe() : null,
    avatarVisualState: () =>
      readAvatarVisualState(getEquipmentLayer, peerAvatarLayers),
  };
}
