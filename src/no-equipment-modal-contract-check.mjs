#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EQUIPMENT_CHOICE_EQUIPPED,
  NO_EQUIPMENT_CHOICE,
  applyNoEquipmentChoice,
  createDefaultEquipmentSelection,
  equipmentChoiceForItems,
  restoreEquipmentSelection,
} from "../web/no-equipment-choice.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail });

const defaultState = createDefaultEquipmentSelection();
check("default choice is explicit none", defaultState.choice === NO_EQUIPMENT_CHOICE.value);
check("default equippedItems is empty", Array.isArray(defaultState.equippedItems) && defaultState.equippedItems.length === 0);

const occupied = [
  { itemId: "hat", attachmentPoint: "head" },
  { itemId: "torch", attachmentPoint: "leftHand" },
  { itemId: "hammer", attachmentPoint: "rightHand" },
  { itemId: "belt", attachmentPoint: "hips" },
];
const removed = applyNoEquipmentChoice(occupied);
check("remove-all clears every slot and extra item", removed.length === 0, `remaining=${removed.length}`);
check("remove-all does not mutate caller state", occupied.length === 4, `source=${occupied.length}`);

const staleRestore = restoreEquipmentSelection({
  choice: NO_EQUIPMENT_CHOICE.value,
  equippedItems: occupied,
});
check("explicit none wins over stale persisted gear", staleRestore.equippedItems.length === 0);
check("restored none remains explicit", staleRestore.choice === NO_EQUIPMENT_CHOICE.value);

const equippedRestore = restoreEquipmentSelection({
  choice: EQUIPMENT_CHOICE_EQUIPPED,
  equippedItems: occupied,
});
check("equipping later remains supported", equippedRestore.equippedItems.length === occupied.length);
check("occupied state maps to equipped choice", equipmentChoiceForItems(occupied) === EQUIPMENT_CHOICE_EQUIPPED);
check("empty state maps to none choice", equipmentChoiceForItems([]) === NO_EQUIPMENT_CHOICE.value);

check(
  "visible None copy is obvious",
  /none/i.test(NO_EQUIPMENT_CHOICE.label) && /remove all equipment/i.test(NO_EQUIPMENT_CHOICE.label),
  NO_EQUIPMENT_CHOICE.label
);
check(
  "accessible label states the removal action",
  /remove all equipped items/i.test(NO_EQUIPMENT_CHOICE.ariaLabel),
  NO_EQUIPMENT_CHOICE.ariaLabel
);

const appSource = readFileSync(path.join(root, "web", "app.js"), "utf8");
const liveSeam = {
  moduleImported: /from\s+["']\.\/no-equipment-choice\.mjs["']/.test(appSource),
  removeAllApplied: /applyNoEquipmentChoice\s*\(/.test(appSource),
  choiceRendered: /NO_EQUIPMENT_CHOICE\.(label|ariaLabel)/.test(appSource),
};
const liveSeamGreen = Object.values(liveSeam).every(Boolean);

const failed = checks.filter((entry) => !entry.pass);
console.log("=== runtime no-equipment modal contract ===");
for (const entry of checks) {
  console.log(`  [${entry.pass ? "PASS" : "FAIL"}] ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`);
}
console.log(`MODULE CONTRACT: ${failed.length === 0 ? "GREEN" : `RED (${failed.length} failed)`}`);
console.log(`LIVE SHELL SEAM: ${liveSeamGreen ? "GREEN" : "RED (serialized integration pending)"}`);
console.log(JSON.stringify(liveSeam));

const requireLiveSeam = process.argv.includes("--require-live-seam");
process.exit(failed.length || (requireLiveSeam && !liveSeamGreen) ? 1 : 0);
