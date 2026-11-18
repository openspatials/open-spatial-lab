// web/wow-extension-pointer.mjs
//
// Pointer input for the extensions of one mount pass: on the page's existing pointer events on the canvas, a ray is
// cast from the camera through the pointer, and the nearest hit on (or under) a `ue-node:` object goes to
// mounted.pointer({ object, type, point }). The mount pass maps the object to the attachment that made it, checks
// ue.input.pointer and throttles (web/wow-extension-mount.mjs); this file only casts the ray. THREE, the camera, the
// scene and the canvas are injected.

const EVENTS = Object.freeze({ pointermove: "move", pointerdown: "down", pointerup: "up", click: "click" });

/**
 * attachExtensionPointer({ THREE, camera, scene, canvas, mounted }) -> { hit(clientX, clientY), dispose() }
 * Listens (passively) on the canvas; hit() returns { object, point } for the nearest `ue-node:` hit, or null.
 */
export function attachExtensionPointer({ THREE, camera, scene = null, canvas, mounted }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const isExtensionNode = (object) => {
    for (let at = object; at; at = at.parent) if (typeof at.name === "string" && at.name.startsWith("ue-node:")) return true;
    return false;
  };
  const roots = () => (mounted && Array.isArray(mounted.records) ? mounted.records.map((record) => record.container).filter(Boolean) : []);

  function hit(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    if (scene && typeof scene.updateMatrixWorld === "function") scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(roots(), true).filter((item) => isExtensionNode(item.object));
    if (!hits.length) return null;
    return { object: hits[0].object, point: hits[0].point.toArray() };
  }

  const listeners = Object.entries(EVENTS).map(([name, type]) => {
    const listener = (event) => {
      const found = hit(event.clientX, event.clientY);
      mounted.pointer({ object: found ? found.object : null, type, point: found ? found.point : null });
    };
    canvas.addEventListener(name, listener, { passive: true });
    return () => canvas.removeEventListener(name, listener);
  });

  return {
    hit,
    dispose() { for (const remove of listeners.splice(0)) remove(); },
  };
}

export default { attachExtensionPointer };
