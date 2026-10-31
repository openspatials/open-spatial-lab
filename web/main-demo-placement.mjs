/*
 * The placement tool in the main demo (`&place=1`, as a Player). It is the viewer's panel (web/wow-portal-mount.mjs,
 * mountPlacementTool), behind the same setting: a world offers placement only when it says so at GET {base}placement.
 * What differs from the `?wow=` viewer is the input: the main demo's camera follows the avatar and a drag turns it.
 * Here a click on the floor places a portal, a drag that starts on a placed portal moves it, a click on a portal
 * selects it, and any other drag still turns the camera. Each change is saved to the world through its Web of Worlds
 * API and read back, so every visitor gets the placed portal from the world's data.
 */

import { mountPlacementTool } from "./wow-portal-mount.mjs";
import { readPlacementPolicy } from "./wow-portal.mjs";

const CLICK_SLOP_PX = 5;

/** The ring groups of the live scene, each with its portal's key. */
function ringGroups(impl, world, keyOf) {
  const out = [];
  const portals = world && Array.isArray(world.portals) ? world.portals : [];
  portals.forEach((portal, index) => {
    const key = keyOf(portal);
    const group = index === 0 ? impl.directionalPortalGroup : impl.additionalPortalGroups && impl.additionalPortalGroups[key] && impl.additionalPortalGroups[key].group;
    if (group) out.push({ portal, group });
  });
  return out;
}

/**
 * Mount it for the world the visitor is in. Returns { ready, dispose } or, when the world does not offer placement,
 * says why through `say` and returns { offered: false, reason }.
 */
export async function mountMainDemoPlacement(deps) {
  const { THREE, document: doc, getImpl, getWorld, keyOf, address, mount, worldsUrl, fetch: fetchImpl, refresh, onChange, say, setSelected, startOn } = deps;
  const policy = await readPlacementPolicy(address, { fetch: fetchImpl });
  if (!policy.allowed) {
    say(policy.reason);
    return { offered: false, reason: policy.reason };
  }
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const rootGroup = new THREE.Group();
  let handlers = null;
  let press = null;

  const aim = (event) => {
    const impl = getImpl();
    if (!impl || !impl.camera) return false;
    const rect = mount.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    impl.camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, impl.camera);
    return true;
  };
  const floorPoint = (event) => {
    if (!aim(event)) return null;
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(floor, hit) ? hit : null;
  };
  const portalAt = (event) => {
    const impl = getImpl();
    if (!impl || !aim(event)) return null;
    let nearest = null;
    for (const { portal, group } of ringGroups(impl, getWorld(), keyOf)) {
      const hit = raycaster.intersectObject(group, true)[0];
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = { portal, distance: hit.distance };
    }
    return nearest ? nearest.portal : null;
  };
  const entryOf = (id) => {
    const world = getWorld();
    const portal = world && Array.isArray(world.portals) ? world.portals.find((p) => Number(p.portal_id) === Number(id)) : null;
    if (!portal) return null;
    const impl = getImpl();
    const found = impl ? ringGroups(impl, world, keyOf).find((candidate) => candidate.portal === portal) : null;
    return {
      id: Number(portal.portal_id),
      label: portal.label || `Portal ${portal.portal_id}`,
      destination: portal.destination || null,
      placed: portal.placed === true,
      node: portal.wow_resource ? portal.wow_resource.node : null,
      nodeId: portal.node_id,
      radius: portal.active_radius_m,
      // What a drag moves while it lasts: the ring. The world's node moves when the drag ends.
      group: {
        parent: rootGroup,
        matrix: {
          fromArray: (m) => {
            if (!found) return;
            found.group.position.set(m[12], found.group.position.y, m[14]);
            found.group.rotation.set(0, Math.atan2(m[8], m[10]), 0);
          },
        },
      },
    };
  };
  const mounted = {
    base: address,
    graph: 1,
    entry: entryOf,
    groupOf: async () => rootGroup,
    refresh,
    setPlacing() {},
    select: (id) => setSelected(id),
  };
  const viewControls = {
    setPlacement(next) {
      handlers = next;
      mount.style.cursor = next ? "crosshair" : "grab";
    },
  };
  const camera = { get position() { const impl = getImpl(); return impl && impl.camera ? impl.camera.position : new THREE.Vector3(); } };
  const tool = mountPlacementTool({
    THREE, document: doc, mounted, viewControls, camera, canvas: { parentNode: mount }, fetch: fetchImpl, worldsUrl, startOn, onChange,
  });
  const inPanel = (event) => !!(event.target && event.target.closest && event.target.closest(".wow-placement-panel"));
  const onDown = (event) => {
    if (!handlers || event.button !== 0 || inPanel(event)) return;
    const portal = portalAt(event);
    press = { x: event.clientX, y: event.clientY, moved: false, portal: null };
    if (portal && handlers.onDragStart && handlers.onDragStart(Number(portal.portal_id)) !== false) {
      press.portal = Number(portal.portal_id);
      // This press moves a portal, so it must not also turn the camera.
      event.stopPropagation();
      event.preventDefault();
    }
  };
  const onMove = (event) => {
    if (!press) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) press.moved = true;
    if (press.portal != null && press.moved && handlers && handlers.onDrag) handlers.onDrag(press.portal, floorPoint(event));
  };
  const onUp = (event) => {
    if (!press) return;
    const was = press;
    press = null;
    if (!handlers) return;
    if (was.portal != null) {
      if (!was.moved) handlers.onPick && handlers.onPick(was.portal);
      else handlers.onDragEnd && void handlers.onDragEnd(was.portal, floorPoint(event));
      return;
    }
    if (was.moved || inPanel(event)) return;
    const onPortal = portalAt(event);
    if (onPortal) handlers.onPick && handlers.onPick(Number(onPortal.portal_id));
    else if (handlers.onFloor) void handlers.onFloor(floorPoint(event));
  };
  // A click in placement mode is for the tool, not for the portal's own information panel.
  const onClick = (event) => { if (handlers && !inPanel(event)) event.stopPropagation(); };
  mount.addEventListener("mousedown", onDown, true);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  mount.addEventListener("click", onClick, true);
  return {
    offered: true,
    ready: tool.ready,
    tool,
    dispose() {
      mount.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      mount.removeEventListener("click", onClick, true);
      tool.dispose();
    },
  };
}
