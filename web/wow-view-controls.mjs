/*
 * Looking, moving and clicking in the `?wow=` player. Browser only.
 *
 *   - drag with the mouse (or one finger) to look around;
 *   - W A S D or the arrow keys to move, Q and E to go down and up, Shift to go faster;
 *   - the mouse wheel to move forward and back;
 *   - click (or tap) a portal to go through it.
 *
 * In placement mode (setPlacement(handlers), web/wow-portal-mount.mjs mountPlacementTool) a click on the
 * floor places a portal, a drag that starts on a portal moves it, and a click on a portal selects it instead
 * of crossing. A drag anywhere else still looks around.
 *
 * The camera is the built scene's own; the scene runtime's render loop draws it every frame, so this
 * module only moves it. A drag that moves more than a few pixels is a look, not a click.
 */

const LOOK_SPEED = 0.004; // radians per pixel dragged
const MOVE_SPEED = 4; // meters per second
const FAST = 3; // Shift multiplies the speed
const WHEEL_STEP = 0.02; // meters per wheel unit
const CLICK_SLOP = 5; // pixels a press may move and still count as a click
const PITCH_LIMIT = Math.PI / 2 - 0.05;
const TAP_SECONDS = 0.125; // a single key tap moves half a meter
const HINT = "Drag to look · W A S D or arrows to move · scroll to go closer · click a portal to go through";
const PLACEMENT_HINT = "Placement: click the floor to place a portal · drag a placed portal to move it · click a portal to edit it";

/**
 * Mount the controls on `canvas` for `camera`. `onPick(id)` is called when a pickable is clicked;
 * `setPickables([{ id, object }])` names what can be clicked. Returns { setPickables, syncFromCamera, dispose }.
 */
export function mountViewControls({ THREE, camera, canvas, document, window, onPick }) {
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const keys = new Set();
  const tapped = new Set(); // keys pressed since the last frame, held or not
  let pickables = [];
  let placement = null; // { onFloor(point), onPick(id), onDragStart(id), onDrag(id, point), onDragEnd(id, point) }
  let press = null;
  const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let frame = 0;
  let last = null;

  function syncFromCamera() {
    euler.setFromQuaternion(camera.quaternion, "YXZ");
  }

  function applyLook() {
    euler.z = 0;
    euler.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, euler.x));
    camera.quaternion.setFromEuler(euler);
    camera.updateMatrixWorld(true);
  }

  function pickAt(clientX, clientY) {
    if (!pickables.length) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables.map((p) => p.object), true);
    for (const hit of hits) {
      for (let at = hit.object; at; at = at.parent) {
        const found = pickables.find((p) => p.object === at);
        if (found) return found;
      }
    }
    return null;
  }

  /** Where a ray from the camera through the page point meets the floor (y = 0), or null. */
  function floorPointAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(FLOOR, hit) ? hit : null;
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    syncFromCamera();
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, dragged: false };
    // In placement mode, a press on a portal may become a drag that moves it.
    if (placement) {
      const hit = pickAt(event.clientX, event.clientY);
      if (hit && placement.onDragStart && placement.onDragStart(hit.id) !== false) press.portal = hit.id;
    }
    // Capture keeps a drag going past the canvas edge; a pointer the browser no longer tracks cannot be captured.
    try { canvas.setPointerCapture(event.pointerId); } catch { /* no capture */ }
    canvas.style.cursor = "grabbing";
  }

  function onPointerMove(event) {
    if (press && event.pointerId === press.id) {
      const dx = event.clientX - press.lastX;
      const dy = event.clientY - press.lastY;
      press.lastX = event.clientX;
      press.lastY = event.clientY;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP) press.dragged = true;
      if (press.portal != null) {
        if (press.dragged && placement && placement.onDrag) placement.onDrag(press.portal, floorPointAt(event.clientX, event.clientY));
        return;
      }
      if (press.dragged) {
        // The scene follows the pointer, as in a street-view viewer: drag left and the view turns right.
        euler.y += dx * LOOK_SPEED;
        euler.x += dy * LOOK_SPEED;
        applyLook();
      }
      return;
    }
    canvas.style.cursor = pickAt(event.clientX, event.clientY) ? (placement ? "move" : "pointer") : placement ? "crosshair" : "grab";
  }

  function onPointerUp(event) {
    if (!press || event.pointerId !== press.id) return;
    const wasClick = !press.dragged;
    const portal = press.portal;
    press = null;
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    canvas.style.cursor = placement ? "crosshair" : "grab";
    if (placement && portal != null) {
      if (wasClick) { if (placement.onPick) placement.onPick(portal); }
      else if (placement.onDragEnd) void placement.onDragEnd(portal, floorPointAt(event.clientX, event.clientY));
      return;
    }
    if (!wasClick) return;
    if (placement) {
      const onPortal = pickAt(event.clientX, event.clientY);
      if (onPortal) { if (placement.onPick) placement.onPick(onPortal.id); }
      else if (placement.onFloor) void placement.onFloor(floorPointAt(event.clientX, event.clientY));
      return;
    }
    const hit = pickAt(event.clientX, event.clientY);
    if (hit && onPick) onPick(hit.id);
  }

  function onWheel(event) {
    event.preventDefault();
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    camera.position.addScaledVector(forward, -event.deltaY * WHEEL_STEP);
    camera.updateMatrixWorld(true);
  }

  function typing(target) {
    const tag = target && target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable);
  }

  const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);

  function onKeyDown(event) {
    if (typing(event.target) || !MOVE_KEYS.has(event.code)) return;
    if (event.code.startsWith("Arrow")) event.preventDefault();
    keys.add(event.code);
    tapped.add(event.code);
    if (!frame) { last = null; frame = window.requestAnimationFrame(step); }
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  function step(timestamp) {
    // A key pressed and released before this frame is a tap: it steps TAP_SECONDS' worth of movement.
    const active = new Set([...keys, ...tapped]);
    const tapOnly = [...tapped].some((k) => !keys.has(k) && !k.startsWith("Shift"));
    tapped.clear();
    const seconds = last == null || tapOnly ? TAP_SECONDS : Math.min(0.1, (timestamp - last) / 1000);
    last = timestamp;
    const moving = [...active].some((k) => !k.startsWith("Shift"));
    if (!moving) { frame = 0; return; }
    const speed = MOVE_SPEED * (active.has("ShiftLeft") || active.has("ShiftRight") ? FAST : 1) * seconds;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-9) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    if (active.has("KeyW") || active.has("ArrowUp")) move.add(forward);
    if (active.has("KeyS") || active.has("ArrowDown")) move.sub(forward);
    if (active.has("KeyD") || active.has("ArrowRight")) move.add(right);
    if (active.has("KeyA") || active.has("ArrowLeft")) move.sub(right);
    if (active.has("KeyE")) move.y += 1;
    if (active.has("KeyQ")) move.y -= 1;
    if (move.lengthSq() > 0) {
      camera.position.addScaledVector(move.normalize(), speed);
      camera.updateMatrixWorld(true);
    }
    frame = window.requestAnimationFrame(step);
  }

  function onBlur() {
    keys.clear();
  }

  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  const hint = document.createElement("div");
  hint.className = "wow-controls-hint";
  hint.textContent = HINT;
  Object.assign(hint.style, {
    position: "absolute", left: "50%", bottom: "64px", transform: "translateX(-50%)", zIndex: "5",
    padding: "6px 12px", borderRadius: "6px", background: "rgba(8, 18, 32, 0.8)", color: "#d8f3ff",
    font: "13px ui-monospace, Menlo, monospace", pointerEvents: "none", whiteSpace: "nowrap",
  });
  if (canvas.parentNode) {
    if (window.getComputedStyle(canvas.parentNode).position === "static") canvas.parentNode.style.position = "relative";
    canvas.parentNode.appendChild(hint);
  }

  syncFromCamera();
  return {
    setPickables(list) { pickables = Array.isArray(list) ? list.filter((p) => p && p.object) : []; },
    /** Placement mode on (handlers) or off (null). */
    setPlacement(handlers) {
      placement = handlers || null;
      canvas.style.cursor = placement ? "crosshair" : "grab";
      hint.textContent = placement ? PLACEMENT_HINT : HINT;
    },
    floorPointAt,
    /** Where the camera is and which way it looks, for checks. */
    pose() {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      return { position: camera.position.toArray(), direction: direction.toArray() };
    },
    syncFromCamera,
    dispose() {
      if (frame) window.cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      hint.remove();
    },
  };
}
