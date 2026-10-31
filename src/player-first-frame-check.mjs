import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(ROOT, "web/index.html"), "utf8");

function validateSources(index) {
  const checks = [];
  const check = (name, assertion) => {
    assertion();
    checks.push(name);
  };

  check("all four connection states have a provenance style", () => {
    for (const state of ["loading", "live", "disconnected", "error"]) {
      assert.match(index, new RegExp(`prov-${state}`));
    }
  });
  check("header, provenance, and footer status start loading rather than green", () => {
    assert.match(index, /id="connection-status"[^>]*>[\s\S]*?Loading<\/span>/);
    assert.match(index, /id="connection-provenance"[^>]*>loading<\/span>/);
    assert.match(index, /id="connection-footer-status"[\s\S]*?prov-loading/);
    assert.doesNotMatch(index, /<span class="live-tag">LIVE backend<\/span>/);
  });
  check("The static page ships a closed but reachable inspector", () => {
    // The live boot and the first mount keep it closed; tools/behavior/app-shell.check.mjs runs that. What stays here is
    // the markup a page has before any script runs.
    assert.match(index, /<div id="app" class="role-source rail-collapsed">/);
    assert.match(index, /data-testid="rail-toggle" aria-expanded="false"/);
    assert.match(index, /id="btn-rail-toggle"[\s\S]*?aria-label="Toggle inspector panel"/);
    assert.match(index, /id="btn-rail-toggle"[\s\S]*?onclick="if \(!window\.__assembly\) \{[\s\S]*?classList\.toggle\('rail-collapsed'\)/);
  });
  check("mobile layout preserves a single-column recovery action", () => {
    assert.match(index, /@media \(max-width: 620px\)/);
    assert.match(index, /\.player-first-frame \.player-first-frame-actions \{ align-items: stretch; flex-direction: column; \}/);
  });
  check("mobile header budgets identity, truth, and every action inside 390px", () => {
    const mobile = index.match(/@media \(max-width: 620px\) \{([\s\S]*?)\n    \}/)?.[1];
    assert.ok(mobile, "mobile header rules must exist");
    assert.match(mobile, /header\.role-banner \{ gap: \d+px; padding: 0 \d+px; \}/);
    assert.match(mobile, /\.role-chip \{ max-width: \d+px; overflow: hidden; text-overflow: ellipsis;/);
    assert.match(mobile, /\.live-tag \{ max-width: \d+px; overflow: hidden; text-overflow: ellipsis;/);
    assert.match(mobile, /\.header-actions \{ gap: \d+px; \}/);
    assert.match(mobile, /\.views-toggle \{ width: \d+px; min-width: \d+px;/);

    const headerRule = mobile.match(/header\.role-banner \{ gap: (\d+)px; padding: 0 (\d+)px; \}/);
    const roleRule = mobile.match(/\.role-chip \{ max-width: (\d+)px;/);
    const statusRule = mobile.match(/\.live-tag \{ max-width: (\d+)px;/);
    const actionsRule = mobile.match(/\.header-actions \{ gap: (\d+)px; \}/);
    const viewsRule = mobile.match(/\.views-toggle \{ width: (\d+)px; min-width: (\d+)px;/);
    const iconRule = index.match(/\.header-icon-button \{[\s\S]*?width: (\d+)px; height:/);
    assert.ok(headerRule && roleRule && statusRule && actionsRule && viewsRule && iconRule);

    const outerGap = Number(headerRule[1]);
    const sidePadding = Number(headerRule[2]);
    const roleMax = Number(roleRule[1]);
    const statusMax = Number(statusRule[1]);
    const actionGap = Number(actionsRule[1]);
    const viewsWidth = Number(viewsRule[1]);
    const iconWidth = Number(iconRule[1]);
    assert.equal(viewsWidth, Number(viewsRule[2]));

    // Worst case includes Views plus refresh, notifications, lobby, and inspector.
    const fixedWidth = (sidePadding * 2) + (outerGap * 3) + roleMax + statusMax
      + viewsWidth + (iconWidth * 4) + (actionGap * 4);
    assert.ok(fixedWidth <= 390, `mobile fixed header budget ${fixedWidth}px exceeds 390px`);
    assert.match(index, /\.loc-title \{[^}]*min-width: 0; flex: 1 1 auto;/);
  });
  return checks;
}

const checks = validateSources(indexSource);

const mutations = {
  "inspector-flashes-open-before-boot": {
    // Drop the static collapsed default: the panel would flash open before JS runs.
    index: indexSource.replace('<div id="app" class="role-source rail-collapsed">', '<div id="app" class="role-source">'),
  },
  "mobile-header-overflow": {
    index: indexSource.replace(".live-tag { max-width: 112px;", ".live-tag { max-width: 160px;"),
  },
  "failed-boot-inspector-does-nothing": {
    index: indexSource.replace("if (!window.__assembly)", "if (false)"),
  },
};

for (const [name, mutated] of Object.entries(mutations)) {
  assert.ok(mutated.index !== indexSource, `mutation ${name} must alter source`);
  let caught = false;
  try {
    validateSources(mutated.index);
  } catch {
    caught = true;
  }
  assert.equal(caught, true, `mutation ${name} must turn the gate RED`);
  console.log(`RED_CAUGHT ${name}`);
}

console.log(`feature_PLAYER_FIRST_FRAME PASS ${checks.length}/${checks.length} mutations=${Object.keys(mutations).length}/${Object.keys(mutations).length}`);
