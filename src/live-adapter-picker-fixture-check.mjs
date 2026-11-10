import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HAT_AND_MUG, wearViaPicker } from "../tools/behavior/live-adapter-page.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";

const inventoryUrl = new URL("../web/equipment-view.js", import.meta.url);
const inventorySource = readFileSync(inventoryUrl, "utf8").replace(/from "(\.\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, inventoryUrl).href)}`);
const { inventorySlots, validateEquippedItems } = await import(`data:text/javascript;base64,${Buffer.from(inventorySource).toString("base64")}`);
const { check, finish } = nodeChecks("live-adapter-picker-fixture");
const originalWindow = globalThis.window;
globalThis.window = { location: { origin: "https://fixture.invalid" } };
const slots = inventorySlots();
if (originalWindow === undefined) delete globalThis.window;
else globalThis.window = originalWindow;

await check("canonical-picker-pairs", "Each delivered picker pair exists in the actual inventory and forms a valid held/worn loadout", () => {
  const items = HAT_AND_MUG.map(([slot, id]) => {
    const item = slots.find(group => group.slot === slot)?.options.find(option => option.itemId === id);
    assert.ok(item, `missing actual inventory pair ${slot}/${id}`);
    return item;
  });
  assert.equal(validateEquippedItems(items).ok, true, "picker fixture still satisfies held/worn requirements");
  assert.deepEqual(items.map(item => item.itemId), ["equip-hat", "equip-mug"]);
});

await check("picker-command-order", "The actual helper opens, selects real item chips, applies and waits for closure", async () => {
  const trace = [], selectors = new Set(slots.flatMap(group => group.options.map(item => `[data-testid="avatar-selector-item-${group.slot}-${item.itemId}"]`)));
  const page = {
    async click(selector) {
      assert.ok(selector === "#btn-switch-avatar" || selector === '[data-testid="avatar-selector-apply"]' || selectors.has(selector), `missing actual inventory selector ${selector}`);
      trace.push(["click", selector]);
    },
    async waitForSelector(selector, options) { trace.push(["wait", selector, Boolean(options.hidden)]); },
  };
  await wearViaPicker(page, HAT_AND_MUG);
  assert.deepEqual(trace, [
    ["click", "#btn-switch-avatar"], ["wait", "#avatar-selector-modal:not([hidden])", false],
    ["click", '[data-testid="avatar-selector-item-head-equip-hat"]'],
    ["click", '[data-testid="avatar-selector-item-leftHand-equip-mug"]'],
    ["click", '[data-testid="avatar-selector-apply"]'], ["wait", "#avatar-selector-modal", true],
  ]);
});

await finish({ checkFile: "src/live-adapter-picker-fixture-check.mjs", faults: [
  { statement: "canonical-picker-pairs", name: "mug picker pair uses the wrong hand", expect: /missing actual inventory pair rightHand\/equip-mug/, edits: [
    { file: "tools/behavior/live-adapter-page.mjs", find: '["leftHand", "equip-mug"]', replace: '["rightHand", "equip-mug"]' },
  ] },
] });
