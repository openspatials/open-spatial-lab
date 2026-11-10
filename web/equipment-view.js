// assetUri must stay an ABSOLUTE http(s) URL (the node-side packet validator
// in src/equipment-foundation.js requires it), so we keep new URL(…, origin) and only make the path
// prefix-aware via the ONE base-path helper. Root mode: withBase() is identity -> unchanged.
import { withBase } from "./base-path.mjs";
import { SHARED_CATALOG_ITEMS } from "./shared-catalog-items.mjs";

const VRM_ATTACHMENT_POINTS = new Set([
  "hips", "spine", "chest", "upperChest", "neck", "head",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
  "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
]);

/**
 * one catalog item (web/assets/
 * equip-catalog.json, self-authored CC0 GLBs). itemId doubles as the asset
 * file basename. localTransforms are the catalog's tuned on-body fits — the
 * layer's 0.2 asset pre-scale is already accounted for (see the catalog's
 * layer_scale_factor note). assetUri is absolute (the node-side packet
 * validator in src/equipment-foundation.js requires an absolute http(s) URI).
 */
function featureItem(record) {
  const itemId = record.key.replace(/^item-/, "");
  const legacy = {
    "equip-hat": [[0, .1, 0], [0, 0, 0, 1]], "equip-helmet": [[0, .08, 0], [0, 0, 0, 1]],
    "equip-crown": [[0, .12, 0], [0, 0, 0, 1]], "equip-torch": [[0, .02, -.03], [0, 0, 0, 1]],
    "equip-shield": [[0, 0, -.02], [0, .7071068, 0, .7071068]],
    "equip-hammer": [[0, .02, -.04], [.5, 0, 0, .8660254]], "equip-mug": [[0, 0, -.03], [0, 0, 0, 1]],
  }[itemId];
  return {
    itemId,
    catalogKey: record.key,
    assetUri: new URL(withBase(record.url), window.location.origin).href,
    attachmentPoint: record.attachment.vrm.humanoid_bone,
    // Retained only for legacy non-evaluator representations. The shared
    // evaluator ignores this transform and publishes its completed body fit.
    localTransform: { position: legacy[0], quaternion: legacy[1], scale: [1, 1, 1] },
    mode: record.attachment.fit.mode,
    label: record.label,
  };
}

/**
 * the inventory — per-slot equippable options for the
 * three simultaneous equip slots (HEAD + LEFT hand + RIGHT hand, #11). Each
 * option is a complete equippedItems[] entry (passes validateEquippedItems and
 * attaches to the slot's real VRM humanoid bone). The player UI (app.js
 * inventory panel) swaps the slot's item live; every entry works on ANY avatar
 * variant including the dwarf.
 */
export function inventorySlots() {
  return [["head", "Head"], ["leftHand", "Left hand"], ["rightHand", "Right hand"]].map(([slot, label]) => ({
    slot, label, options: SHARED_CATALOG_ITEMS.filter(record => record.attachment.vrm.humanoid_bone === slot).map(featureItem),
  }));
}

export function defaultEquippedItems() {
  // the default loadout fills THREE slots at once —
  // RIGHT hand + LEFT hand + HEAD — each on its correct VRM humanoid bone,
  // using the real GLB items (first option of every inventory slot).
  // Replaces the old two-item lantern/visor pair; the visor block that sat on
  // the head is gone with it (see #10 in avatar-equipment-layer.js for the
  // blue head bar itself). Still >= 1 held + >= 1 worn, so the
  // schema invariants hold unchanged.
  const slots = inventorySlots();
  const first = (slot) => slots.find((entry) => entry.slot === slot).options[0];
  return [first("rightHand"), first("leftHand"), first("head")];
}

/**
 * step 5: the runtime-equippable catalog — additional
 * held/worn items (reusing the existing local GLB assets) that can be equipped
 * onto the avatar at runtime via LiveAdapter.equipCatalogItem(). Every entry
 * passes validateEquippedItems() and attaches to a real VRM humanoid bone.
 */
export function equipmentCatalog() {
  return inventorySlots().flatMap((slot) => slot.options.map((item) => ({ ...item })));
}
export function validateEquippedItems(items) {
  const errors = [];
  if (!Array.isArray(items)) return { ok: false, errors: ["equippedItems must be an array"] };
  // an avatar with NO equipment is a valid state — the clean
  // base avatar is the demo's default spawn. Empty short-circuits the held/worn
  // completeness rule below (that rule governs a NON-empty loadout only), so the
  // intentionally-empty avatar never reads as a "schema FAIL".
  if (items.length === 0) return { ok: true, errors: [] };
  const modes = new Set();
  for (const [index, item] of items.entries()) {
    const path = `equippedItems[${index}]`;
    if (!item.itemId) errors.push(`${path}.itemId missing`);
    if (!item.assetUri) errors.push(`${path}.assetUri missing`);
    if (!VRM_ATTACHMENT_POINTS.has(item.attachmentPoint)) errors.push(`${path}.attachmentPoint invalid`);
    if (item.mode !== "held" && item.mode !== "worn") errors.push(`${path}.mode invalid`);
    else modes.add(item.mode);
    const t = item.localTransform || {};
    const q = t.quaternion || t.rotation;
    if (!Array.isArray(t.position) || t.position.length !== 3) errors.push(`${path}.localTransform.position invalid`);
    if (!Array.isArray(q) || q.length !== 4) errors.push(`${path}.localTransform.quaternion invalid`);
    if (!Array.isArray(t.scale) || t.scale.length !== 3) errors.push(`${path}.localTransform.scale invalid`);
  }
  if (!modes.has("held")) errors.push("missing held item");
  if (!modes.has("worn")) errors.push("missing worn item");
  return { ok: errors.length === 0, errors };
}

export async function resolveEquipmentItems(items) {
  const validation = validateEquippedItems(items);
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const status = {
      itemId: item.itemId,
      mode: item.mode,
      attachmentPoint: item.attachmentPoint,
      assetUri: item.assetUri,
      fetch_ok: false,
      visible_fallback: false,
      message: "",
    };
    try {
      const res = await fetch(item.assetUri, { cache: "no-store" });
      status.fetch_ok = res.ok;
      status.message = res.ok ? `asset fetch ${res.status}` : `asset fetch failed ${res.status}`;
      status.visible_fallback = !res.ok;
    } catch (err) {
      status.message = `asset fetch error: ${err.message}`;
      status.visible_fallback = true;
    }
    results.push(status);
  }
  return {
    validation,
    items: results,
    reconstructor_step:
      "Phase 3 replaces this visible DOM scaffold with GLTFLoader + VRM bone attach + localTransform + physics-last ordering.",
  };
}
