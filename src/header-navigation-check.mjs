import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mutation = process.argv.find((argument) => argument.startsWith("--mutate="))?.slice(9) || null;
const sourcePaths = {
  index: "web/index.html",
  launcher: "web/demo-shell-bootstrap.mjs",
  destinations: "web/semantic-destinations-controller.mjs",
  app: "web/app.js",
  e2e: "src/header-navigation-e2e.mjs",
};
const sources = Object.fromEntries(await Promise.all(Object.entries(sourcePaths).map(async ([key, relativePath]) => [
  key,
  await readFile(path.join(root, relativePath), "utf8"),
])));

const mutations = {
  "home-symbol": () => { sources.index = sources.index.replace('d="M3 10.5 12 3l9 7.5"', 'd="M3 3h18"'); },
  "lobby-symbol": () => { sources.index = sources.index.replace('aria-hidden="true">L</span>', 'aria-hidden="true">H</span>'); },
  "map-symbol": () => { sources.index = sources.index.replace('d="m3 5.5 6-2 6 2 6-2v15l-6 2-6-2-6 2z"', 'd="M3 12h18"'); },
  "views-borderless": () => { sources.index = sources.index.replace("border-color: transparent; border-radius: 0;", "border-color: var(--line); border-radius: 12px;"); },
  "views-click-target": () => { sources.launcher = sources.launcher.replace('getElementById("btn-views-home")', 'getElementById("btn-views-home-mutated")'); },
  "destinations-click-target": () => { sources.destinations = sources.destinations.replace('lookup("btn-semantic-destinations"), "click"', 'lookup("btn-semantic-destinations-mutated"), "click"'); },
  "lobby-click-target": () => { sources.app = sources.app.replace('listenAtRoot(btn, "click", handleReturnLobbyClick);', 'listenAtRoot(btn, "click", () => {});'); },
  "accessible-names": () => { sources.index = sources.index.replace('aria-label="Open mission views"', 'aria-label=""'); },
  "destinations-expanded": () => { sources.destinations = sources.destinations.replace('String(openState)', 'String(false)'); },
  "stale-visible-layer": () => { sources.index = sources.index.replace('</svg>\n        </button>', '</svg><span>Views</span>\n        </button>'); },
  "geometry-contract": () => { sources.index = sources.index.replace("flex: 0 0 auto; min-width: max-content;", "flex: 1 1 auto; min-width: 0;"); },
  "focus-missing-control": () => { sources.e2e = sources.e2e.replace(/\n  \{ key: "camera", id: "btn-camera-toggle"[^\n]+/, ""); },
  "focus-unreachable-control": () => { sources.e2e = sources.e2e.replace('id: "btn-switch-avatar"', 'id: "btn-switch-avatar-missing"'); },
  "focus-wrong-order": () => {
    const camera = sources.e2e.match(/  \{ key: "camera"[^\n]+/)?.[0] || "";
    const avatar = sources.e2e.match(/  \{ key: "avatar"[^\n]+/)?.[0] || "";
    sources.e2e = sources.e2e.replace(`${camera}\n${avatar}`, `${avatar}\n${camera}`);
  },
  "hidden-control-focus-leak": () => {
    sources.index = sources.index.replace(
      "#btn-semantic-destinations, #btn-runtime-tweaks { display: none; }",
      "#btn-semantic-destinations, #btn-runtime-tweaks { display: inline-flex; }",
    );
  },
  "hidden-control-accessibility-leak": () => {
    sources.index = sources.index.replace('aria-hidden="true" tabindex="-1" hidden', "hidden");
  },
  "protected-port-use": () => {
    sources.e2e = sources.e2e.replace("airport: 18933", "airport: 18154");
  },
  "pass-artifact-nonterminal-parent": () => {
    sources.e2e = sources.e2e.replace(/main\(\)\.then\([\s\S]*?\n\);\s*$/, "await main();\n");
  },
  "missing-socket-resource-cleanup": () => {
    sources.e2e = sources.e2e.replace("parentTcpSocketsReleased = diagnostics.cleanup.parentTcpSockets.length === 0", "parentTcpSocketsReleased = true");
  },
  "untruthful-forced-success": () => {
    sources.e2e = sources.e2e.replace("terminateAfterFlush(error.exitCode || 1, error)", "terminateAfterFlush(0, error)");
  },
};

if (mutation) {
  assert.ok(mutations[mutation], `unknown mutation ${mutation}`);
  mutations[mutation]();
}

const checks = [];
async function check(name, assertion) {
  await assertion();
  checks.push(name);
}

const headerMarkup = sources.index.match(/<header class="role-banner">[\s\S]*?<\/header>/)?.[0] || "";
const viewsMarkup = headerMarkup.match(/<button class="header-icon-button views-toggle"[\s\S]*?<\/button>/)?.[0] || "";
const destinationsMarkup = headerMarkup.match(/<button class="header-icon-button destinations-toggle"[\s\S]*?<\/button>/)?.[0] || "";
const runtimeMarkup = headerMarkup.match(/<button class="header-icon-button runtime-tweak-toggle"[\s\S]*?<\/button>/)?.[0] || "";
const lobbyMarkup = headerMarkup.match(/<button class="header-icon-button lobby-return-toggle"[\s\S]*?<\/button>/)?.[0] || "";

await check("home icon is local, decorative, and the only visible Views content", () => {
  assert.match(viewsMarkup, /<svg class="header-action-icon"[\s\S]*?aria-hidden="true" focusable="false">/);
  assert.match(viewsMarkup, /d="M3 10\.5 12 3l9 7\.5"/);
  assert.doesNotMatch(viewsMarkup, />\s*Views\s*</);
});

await check("return control contains the exact capital L decorative symbol", () => {
  assert.match(lobbyMarkup, /<span class="lobby-return-label" aria-hidden="true">L<\/span>/);
  assert.doesNotMatch(lobbyMarkup, /⌂|<svg/);
});

await check("hidden Destinations compatibility control retains its local decorative map", () => {
  assert.match(destinationsMarkup, /<svg class="header-action-icon"[\s\S]*?aria-hidden="true" focusable="false">/);
  assert.match(destinationsMarkup, /d="m3 5\.5 6-2 6 2 6-2v15l-6 2-6-2-6 2z"/);
  assert.doesNotMatch(destinationsMarkup, />\s*Destinations\s*</);
});

await check("Views resting treatment is borderless without shrinking its hit target", () => {
  assert.match(sources.index, /\.header-actions \.views-toggle \{ border-color: transparent; border-radius: 0;[\s\S]*?background: transparent; box-shadow: none; \}/);
  assert.match(sources.index, /\.header-icon-button \{ flex: 0 0 40px;[\s\S]*?width: 40px; height: 40px; min-width: 40px;/);
  assert.match(sources.index, /header\.role-banner :focus-visible[\s\S]*?outline: 3px solid var\(--osl-glass-focus\)/);
});

await check("Views keeps exactly one existing launcher click owner", () => {
  assert.match(sources.launcher, /const viewsButton = document\.getElementById\("btn-views-home"\);/);
  assert.equal((sources.launcher.match(/viewsButton\?\.addEventListener\("click"/g) || []).length, 1);
  assert.match(sources.launcher, /showLauncher\(\{ dismissible: true \}\)/);
});

await check("hidden Destinations compatibility control keeps exactly one toggle click owner", () => {
  assert.equal((sources.destinations.match(/listen\(lookup\("btn-semantic-destinations"\), "click"/g) || []).length, 1);
  assert.match(sources.destinations, /openState \? close\(\) : open\(\)/);
});

await check("lobby return keeps exactly one existing guarded click owner", () => {
  assert.equal((sources.app.match(/listenAtRoot\(btn, "click", handleReturnLobbyClick\);/g) || []).length, 1);
  assert.match(sources.app, /btn\.dataset\.returnLobbyWired === "1"/);
  assert.match(sources.app, /if \(!adapter \|\| returnToLobbyInFlight\) return;/);
});

await check("names, tooltips, ids, test ids, and controls relationship remain exact", () => {
  assert.match(viewsMarkup, /id="btn-views-home"[\s\S]*?data-testid="views-home" title="Open mission views" aria-label="Open mission views"/);
  assert.match(destinationsMarkup, /id="btn-semantic-destinations"[\s\S]*?data-testid="semantic-destinations-toggle" aria-expanded="false"[\s\S]*?aria-controls="semantic-destinations-panel"[\s\S]*?title="World destinations" aria-label="Open world destinations"[\s\S]*?aria-hidden="true" tabindex="-1" hidden/);
  assert.match(runtimeMarkup, /id="btn-runtime-tweaks"[\s\S]*?data-testid="runtime-tweak-toggle" aria-expanded="false"[\s\S]*?aria-controls="runtime-tweak-palette"[\s\S]*?aria-label="Open runtime tweak palette" aria-hidden="true" tabindex="-1" hidden/);
  assert.match(lobbyMarkup, /id="btn-return-lobby"[\s\S]*?data-testid="return-lobby-button"[\s\S]*?title="Return to lobby" aria-label="Return to lobby" hidden/);
});

await check("removed controls stay out of layout, focus, and accessibility while retaining compatibility DOM", () => {
  assert.match(sources.index, /#btn-semantic-destinations, #btn-runtime-tweaks \{ display: none; \}/);
  assert.match(sources.e2e, /ownerHiddenControls: \["btn-semantic-destinations", "btn-runtime-tweaks"\]/);
  assert.match(sources.e2e, /assert\.equal\(hiddenControl\.display, "none"/);
  assert.match(sources.e2e, /assert\.equal\(hiddenControl\.ariaHidden, "true"/);
  assert.match(sources.e2e, /assert\.equal\(hiddenControl\.tabIndex, -1/);
  assert.match(sources.e2e, /accessibility\.snapshot\(\{ root: handle, interestingOnly: false \}\), null/);
});

await check("Destinations expanded state is rendered from the existing open state", () => {
  assert.match(sources.destinations, /toggle\?\.setAttribute\?\.\("aria-expanded", String\(openState\)\);/);
  assert.match(sources.destinations, /function open\(\) \{[\s\S]*?openState = true;[\s\S]*?render\(\{ forceFocus: true \}\);/);
  assert.match(sources.destinations, /function close\(\) \{[\s\S]*?openState = false;[\s\S]*?render\(\);/);
});

await check("no stale visible Views, Destinations, or narrow pseudo label survives", () => {
  assert.doesNotMatch(viewsMarkup, />\s*Views\s*</);
  assert.doesNotMatch(destinationsMarkup, />\s*Destinations\s*</);
  assert.doesNotMatch(sources.index, /\.destinations-toggle::(?:before|after)[\s\S]*?content\s*:/);
  assert.doesNotMatch(sources.index, /content:\s*["']Go["']/);
});

await check("header geometry contract keeps the action cluster fixed and the identity yielding", () => {
  assert.match(sources.index, /\.loc-title \{[^}]*min-width: 0; flex: 1 1 auto;/);
  assert.match(sources.index, /\.header-actions \{ flex: 0 0 auto; min-width: max-content;[\s\S]*?gap: 7px;[\s\S]*?isolation: isolate; \}/);
  assert.match(sources.index, /\.header-actions > \.header-icon-button:focus-visible \{ z-index: 1; \}/);
  assert.match(sources.index, /@media \(max-width: 620px\)[\s\S]*?\.header-actions \{ gap: 3px; \}[\s\S]*?\.header-icon-button \{ flex-basis: 30px; width: 30px; height: 30px; min-width: 30px;/);
});

await check("headed driver reaches every remaining visible Player header control once in DOM order", () => {
  const block = sources.e2e.match(/const controls = Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1] || "";
  const ids = [
    "btn-views-home",
    "btn-camera-toggle",
    "btn-switch-avatar",
    "btn-refresh-settings",
    "btn-notifications",
    "btn-return-lobby",
    "btn-rail-toggle",
  ];
  let previous = -1;
  for (const id of ids) {
    const index = block.indexOf(`id: "${id}"`);
    assert.ok(index > previous, `missing or wrongly ordered headed control ${id}`);
    previous = index;
  }
  assert.equal((block.match(/\{ key:/g) || []).length, ids.length);
  assert.match(sources.e2e, /for \(let index = 0; index < expectedOrder\.length; index \+= 1\)/);
  assert.match(sources.e2e, /assert\.deepEqual\(order, expectedOrder/);
});

await check("headed driver documents and reaches the complete source/server sequence", () => {
  assert.match(sources.index, /#btn-camera-toggle\[hidden\], #btn-switch-avatar\[hidden\], #btn-return-lobby\[hidden\] \{ display: none; \}/);
  assert.match(sources.index, /#btn-semantic-destinations, #btn-runtime-tweaks \{ display: none; \}/);
  assert.match(sources.e2e, /const expectedSourceOrder = Object\.freeze\(\[[\s\S]*?"btn-camera-toggle"[\s\S]*?"btn-rail-toggle"[\s\S]*?\]\);/);
  assert.match(sources.e2e, /role=source&active=source&intro=0/);
  assert.match(sources.e2e, /assert\.deepEqual\(sourceVisibleOrder, expectedSourceOrder/);
  assert.match(sources.e2e, /assert\.deepEqual\(sourceFocusOrder, expectedSourceOrder/);
  assert.match(sources.e2e, /new Set\(sourceFocusOrder\)\.size, expectedSourceOrder\.length/);
});

await check("headed driver owns every backend and never connects to protected ports", () => {
  assert.match(sources.e2e, /const ports = Object\.freeze\(\{ frontend: 18929, a: 18930, b: 18931, lobby: 18932, airport: 18933 \}\);/);
  assert.match(sources.e2e, /assertNotLiveDemoPorts\(\{ a: ports\.a, b: ports\.b, lobby: ports\.lobby, airport: ports\.airport \}\);/);
  assert.match(sources.e2e, /startBackends\(\{[\s\S]*?airport: ports\.airport[\s\S]*?includeAirport: true/);
  assert.match(sources.e2e, /createFrontendServer\(ports\.frontend, \{[\s\S]*?airport: ports\.airport[\s\S]*?includeAirport: true/);
  assert.match(sources.e2e, /execFileAsync\("lsof", \["-nP", `-iTCP:\$\{port\}`, "-sTCP:LISTEN", "-Fp"\]\)/);
  assert.doesNotMatch(sources.e2e, /createConnection\(\{ host: "127\.0\.0\.1", port \}\)/);
});

await check("headed driver rejects a PASS artifact with a nonterminal parent", () => {
  assert.match(sources.e2e, /async function terminateAfterFlush\(code, error = null\)[\s\S]*?process\.exit\(code\);/);
  assert.match(sources.e2e, /main\(\)\.then\([\s\S]*?terminateAfterFlush\(0\)[\s\S]*?terminateAfterFlush\(error\.exitCode \|\| 1, error\)/);
});

await check("headed driver proves worker ports, browser processes, and parent TCP sockets released", () => {
  assert.match(sources.e2e, /waitForPortsReleased\(Object\.values\(ports\)\)/);
  assert.match(sources.e2e, /browserProcessesReleased = diagnostics\.profile\.processes_after_close\.length === 0/);
  assert.match(sources.e2e, /parentTcpSocketsReleased = diagnostics\.cleanup\.parentTcpSockets\.length === 0/);
  assert.match(sources.e2e, /if \(!diagnostics\.cleanup\.parentTcpSocketsReleased\) cleanupErrors\.push/);
});

await check("headed driver cannot force a failed run to exit successfully", () => {
  assert.match(sources.e2e, /if \(failure\) throw failure;/);
  assert.match(sources.e2e, /\(error\) => terminateAfterFlush\(error\.exitCode \|\| 1, error\)/);
  assert.doesNotMatch(sources.e2e, /\(error\) => terminateAfterFlush\(0, error\)/);
});

process.stdout.write(`runtime header navigation check: ${checks.length}/${checks.length} pass${mutation ? ` (mutation ${mutation} unexpectedly survived)` : ""}\n`);
