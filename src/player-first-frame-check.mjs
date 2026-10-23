import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(join(ROOT, "web/app.js"), "utf8");
const indexSource = readFileSync(join(ROOT, "web/index.html"), "utf8");

function validateSources(app, index) {
  const checks = [];
  const check = (name, assertion) => {
    assertion();
    checks.push(name);
  };

  check("all four connection states have explicit presentation", () => {
    for (const state of ["loading", "live", "disconnected", "error"]) {
      assert.match(app, new RegExp(`\\b${state}: \\{ label:`));
      assert.match(index, new RegExp(`prov-${state}`));
    }
  });
  check("header, provenance, and footer status start loading rather than green", () => {
    assert.match(index, /id="connection-status"[^>]*>[\s\S]*?Loading<\/span>/);
    assert.match(index, /id="connection-provenance"[^>]*>loading<\/span>/);
    assert.match(index, /id="connection-footer-status"[\s\S]*?prov-loading/);
    assert.doesNotMatch(index, /<span class="live-tag">LIVE backend<\/span>/);
  });
  check("one state setter owns all visible connection claims", () => {
    assert.match(app, /function setConnectionPresentation\(state, detail, failedPath = null\)/);
    for (const id of ["connection-status", "connection-footer-status", "connection-provenance", "live-backend"]) {
      assert.match(app, new RegExp(`\\$\\(\"${id}\"\\)`));
    }
    assert.match(app, /document\.body\.setAttribute\("data-connection-state", state\)/);
  });
  check("Every role defaults to a closed but reachable inspector", () => {
    // the inspector (right rail) is CLOSED by default for
    // every live role. Three source facts together guarantee it with no flash:
    //   1. static markup ships #app.rail-collapsed (collapsed on first paint,
    //      and throughout `await adapter.init()` before the panel controller mounts);
    //   2. the live boot className is role-`${role} rail-collapsed` for EVERY role
    //      (not just players);
    //   3. the panel chrome controller force-opens the panel on first mount
    //      (wirePanelChrome -> setPanelOpen(true)), so the live path immediately
    //      re-collapses it via chromeDriver().close() — same frame, no flash.
    // Miss any one and the inspector defaults open again (the complaint).
    assert.match(app, /appEl\.className = `role-\$\{role\} rail-collapsed`/);
    assert.match(app, /initialRailToggle\.setAttribute\("aria-expanded", "false"\)/);
    assert.match(app, /panelTruthChromeController\.chromeDriver\(\)\.close\(\)/);
    assert.match(index, /<div id="app" class="role-source rail-collapsed">/);
    assert.match(index, /data-testid="rail-toggle" aria-expanded="false"/);
    assert.match(index, /id="btn-rail-toggle"[\s\S]*?aria-label="Toggle inspector panel"/);
    assert.match(index, /id="btn-rail-toggle"[\s\S]*?onclick="if \(!window\.__assembly\) \{[\s\S]*?classList\.toggle\('rail-collapsed'\)/);
  });
  check("healthy Player first frame gives orientation and one primary action", () => {
    assert.match(app, /data-testid="player-first-frame"/);
    assert.match(app, /You’re in \$\{escapeHtml\(title\)\}/);
    assert.match(app, /W A S D to walk · drag to look · scroll to zoom/);
    assert.match(app, /data-testid="start-exploring"/);
    assert.match(app, /CONTROL_KEY_MAP\[ev\.code\] && !playerOrientationDismissed/);
    assert.match(app, /\[data-testid="player-first-frame"\]\[data-connection-state="live"\]/);
    assert.match(app, /if \(!playerOrientationDismissed && orientation\) \{[\s\S]*?playerOrientationDismissed = true;[\s\S]*?renderOverlay\(/);
    assert.doesNotMatch(app, /addEventListener\("keydown"[\s\S]*?playerOrientationDismissed/);
  });
  check("unavailable Player state is centered, accessible, and recoverable", () => {
    assert.match(app, /data-testid="player-connection-card"/);
    assert.match(app, /role="\$\{failed \? "alert" : "status"\}"/);
    assert.match(app, /data-testid="connection-retry"/);
    assert.match(app, /location\.reload\(\)/);
  });
  check("request failures derive disconnected and error rather than live", () => {
    assert.match(app, /!request\.ok && Number\(request\.status\) === 0/);
    assert.match(app, /setConnectionPresentation\("disconnected"/);
    assert.match(app, /!request\.ok && Number\(request\.status\) >= 500/);
    assert.match(app, /setConnectionPresentation\(\s*"error"/);
    assert.match(app, /request\.path === connectionPresentation\.failed_path/);
  });
  check("successful boot is the only initial path that declares live", () => {
    assert.match(app, /main\(\)[\s\S]*?\.then\(\(\) => \{[\s\S]*?setConnectionPresentation\("live"/);
    assert.match(app, /disconnected \? "disconnected" : "error"/);
  });
  check("network loss is root-managed and has an explicit disconnected transition", () => {
    assert.match(app, /listenAtRoot\(window, "offline", handleOffline\)/);
    assert.match(
      app,
      /function listenAtRoot\(target, type, listener, options\) \{[\s\S]*?target\.addEventListener\(type, listener, options\);[\s\S]*?rootListenerRemovers\.push\(\(\) => target\.removeEventListener\(type, listener, options\)\);[\s\S]*?\}/,
    );
    assert.match(
      app,
      /function disposeApplication\(\) \{[\s\S]*?rootListenerRemovers\.splice\(0\)\.reverse\(\)[\s\S]*?remove\(\)/,
    );
    assert.doesNotMatch(app, /window\.addEventListener\("offline"/);
    assert.match(app, /This browser is offline/);
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

const checks = validateSources(appSource, indexSource);

const mutations = {
  "hard-coded-green": {
    app: appSource.replace(
      'disconnected ? "disconnected" : "error"',
      'disconnected ? "live" : "live"',
    ),
    index: indexSource,
  },
  "inspector-default-open": {
    // Drop the post-mount re-collapse: the controller's mount would then leave
    // the inspector force-opened on the live path (the original bug).
    app: appSource.replace("panelTruthChromeController.chromeDriver().close();", "void 0;"),
    index: indexSource,
  },
  "inspector-flashes-open-before-boot": {
    // Drop the static collapsed default: the panel would flash open before JS runs.
    app: appSource,
    index: indexSource.replace('<div id="app" class="role-source rail-collapsed">', '<div id="app" class="role-source">'),
  },
  "retry-does-nothing": {
    app: appSource.replace("location.reload()", "void location"),
    index: indexSource,
  },
  "mobile-header-overflow": {
    app: appSource,
    index: indexSource.replace(".live-tag { max-width: 112px;", ".live-tag { max-width: 160px;"),
  },
  "failed-boot-inspector-does-nothing": {
    app: appSource,
    index: indexSource.replace("if (!window.__assembly)", "if (false)"),
  },
  "managed-offline-listener-removed": {
    app: appSource.replace(
      'listenAtRoot(window, "offline", handleOffline);',
      "void handleOffline;",
    ),
    index: indexSource,
  },
};

for (const [name, mutated] of Object.entries(mutations)) {
  assert.ok(mutated.app !== appSource || mutated.index !== indexSource, `mutation ${name} must alter source`);
  let caught = false;
  try {
    validateSources(mutated.app, mutated.index);
  } catch {
    caught = true;
  }
  assert.equal(caught, true, `mutation ${name} must turn the gate RED`);
  console.log(`RED_CAUGHT ${name}`);
}

console.log(`feature_PLAYER_FIRST_FRAME PASS ${checks.length}/11 mutations=${Object.keys(mutations).length}/${Object.keys(mutations).length}`);
