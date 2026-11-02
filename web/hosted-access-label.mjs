/*
 * What a hosted object whose asset is not public shows (the rule is wow-asset.js primitiveAssetAccess):
 *   - in its own world, the object as itself with a small label above it, "Restricted" or "Hidden";
 *   - seen from another world, a restricted object as a faint box of its size with the same label. A hidden one is
 *     never sent there, so it is never drawn.
 * The label is a canvas texture (label-canvas.mjs), which shows under every page policy the app is served with.
 */
import { drawLabelCanvas } from "./label-canvas.mjs";

const LOOKS = Object.freeze({
  restricted: Object.freeze({ text: "Restricted", stroke: "#ffc400" }),
  hidden: Object.freeze({ text: "Hidden", stroke: "#c03cff" }),
});
const LABEL_CANVAS_WIDTH = 560;
const LABEL_WIDTH_M = 0.9;
const LABEL_GAP_M = 0.2;
const GHOST_COLOR = 0xdfe4ec;
const GHOST_OPACITY = 0.16;

/** A world from before the field names no access: its objects are public, as they were. */
export function hostedAccessOf(definition) {
  const access = definition?.asset_access;
  return typeof access === "string" && access ? access : "public";
}

function labelCanvas(doc, access) {
  const look = LOOKS[access];
  if (!look) return null;
  return drawLabelCanvas(doc, [look.text], { background: "rgba(10, 12, 18, 0.85)", stroke: look.stroke, color: "#ffffff" },
    { width: LABEL_CANVAS_WIDTH });
}

/** Width, height and the height of its centre above the object's centre, in metres. */
function labelBox(canvas, sizeM) {
  const height = (LABEL_WIDTH_M * canvas.height) / canvas.width;
  return { width: LABEL_WIDTH_M, height, y: sizeM / 2 + LABEL_GAP_M + height / 2 };
}

/** three.js: a sprite above an object of `sizeM`, facing the viewer; null for a public object or without a document. */
export function accessLabelThree(THREE, doc, access, sizeM) {
  const canvas = labelCanvas(doc, access);
  if (!canvas) return null;
  const texture = new THREE.CanvasTexture(canvas);
  if ("SRGBColorSpace" in THREE) texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  const box = labelBox(canvas, sizeM);
  sprite.scale.set(box.width, box.height, 1);
  sprite.position.y = box.y;
  sprite.name = `hosted-access-label:${access}`;
  // The object under it is what a drag picks up.
  sprite.raycast = () => {};
  return sprite;
}

/** X3DOM and X_ITE, through the render adapter: the same label on a quad that turns to face the viewer. */
export function accessLabelX3d(adapter, doc, access, sizeM) {
  const canvas = labelCanvas(doc, access);
  if (!canvas) return null;
  const box = labelBox(canvas, sizeM);
  const material = adapter.createMaterial({ type: "sprite", map: adapter.createCanvasTexture(canvas) });
  const sprite = adapter.createSprite(material, { width: box.width, height: box.height });
  adapter.setName(sprite, `hosted-access-label:${access}`);
  adapter.setPosition(sprite, 0, box.y, 0);
  return sprite;
}

/** three.js: another world's restricted object, a faint box with its outline and its label, centred on its node. */
export function accessGhostThree(THREE, doc, sizeM) {
  const group = new THREE.Group();
  group.name = "hosted-access-ghost-group";
  const geometry = new THREE.BoxGeometry(sizeM, sizeM, sizeM);
  const box = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: GHOST_OPACITY, depthWrite: false }));
  box.name = "hosted-access-ghost:restricted";
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.8 }));
  edges.name = "hosted-access-ghost-edges";
  group.add(box, edges);
  const label = accessLabelThree(THREE, doc, "restricted", sizeM);
  if (label) group.add(label);
  return group;
}

/** X3DOM and X_ITE: the same ghost. The caller places the group at the node's matrix. */
export function accessGhostX3d(adapter, doc, sizeM) {
  const group = adapter.createGroup("hosted-access-ghost:restricted");
  const geometry = adapter.createGeometry({ type: "box", width: sizeM, height: sizeM, depth: sizeM });
  adapter.add(group, adapter.createMesh(geometry, adapter.createMaterial({ type: "standard", color: GHOST_COLOR, emissive: GHOST_COLOR, emissiveIntensity: 0.6, transparent: true, opacity: GHOST_OPACITY })));
  adapter.add(group, adapter.createLineSegments(adapter.createGeometry({ type: "edges", from: geometry }), adapter.createMaterial({ type: "line", color: GHOST_COLOR })));
  const label = accessLabelX3d(adapter, doc, "restricted", sizeM);
  if (label) adapter.add(group, label);
  return group;
}
