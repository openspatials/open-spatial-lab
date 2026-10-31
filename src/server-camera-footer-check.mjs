#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverViewToggle } from "../tools/behavior/server-view-check.mjs";
import { serverViewFaults } from "../tools/behavior/controller-faults.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  index: path.join(ROOT, "web", "index.html"),
  launcher: path.join(ROOT, "web", "demo-launcher.mjs"),
  dashboard: path.join(ROOT, "web", "wow-dashboard.html"),
  noscript: path.join(ROOT, "web", "demo-launcher-preview.html"),
};

const ATTRIBUTION = "Open Spatial Lab by Grig Bilham, with contributors";

function replaceOnce(value, before, after) {
  assert.ok(value.includes(before), `mutation target missing: ${before}`);
  return value.replace(before, after);
}

function validateSources(source) {
  assert.match(source.index, /id="btn-camera-toggle"[\s\S]*?<svg class="header-action-icon"/);

  const footer = source.index.match(/<span class="footer-links">([\s\S]*?)<\/span>\s*<\/footer>/)?.[1] || "";
  const anchors = [...footer.matchAll(/<a class="footer-link ([^"]+)" href="([^"]+)"[\s\S]*?>([^<]+)<\/a>/g)]
    .map((match) => ({ className: match[1], href: match[2], label: match[3].trim() }));
  assert.deepEqual(anchors, [
    {
      className: "footer-hosted-link",
      href: "https://lab.openspatials.com/",
      label: "lab.openspatials.com",
    },
  ]);
  assert.ok(footer.includes(`<span class="footer-attribution" data-testid="footer-attribution">${ATTRIBUTION}</span>`));
  assert.ok(source.launcher.includes(`attribution.textContent = "${ATTRIBUTION}";`));
  assert.ok(source.launcher.includes("dock.append(attribution, hostedLink);"));
  assert.match(source.dashboard, new RegExp(`<footer>[^\\n]*${ATTRIBUTION}</footer>`));
  assert.ok(source.noscript.includes(`<p>${ATTRIBUTION}</p>`));
  assert.doesNotMatch(source.index + source.launcher, /labs\.peers\.social/);
  assert.doesNotMatch(footer, />_|↗|footer-github-mark|footer-github-link|github\.com\/grigb\/open-spatial-lab/);
  assert.doesNotMatch(source.index, /class="footer-github-mark"/);
  assert.match(source.index, /\.footer-links \{[^}]*width: 100%[^}]*justify-content: center/);
  assert.match(source.index, /\.footer-link \{[^}]*max-width: 100%[^}]*font-family: inherit[^}]*font-size: clamp\(17px, 5vw, 21px\)[^}]*font-weight: 600[^}]*line-height: 1\.2[^}]*overflow-wrap: anywhere[^}]*text-align: center/s);
  assert.doesNotMatch(source.index, /\.footer-(?:hosted|github)-link \{[^}]*margin-(?:left|right): auto/);
  // The panel stands on the footer's measured height, and the footer's own min-height does not read it.
  assert.match(source.index, /--osl-footer-height: max\(var\(--osl-shell-footer-height\), var\(--osl-footer-measured, 0px\)\)/);
  assert.match(source.index, /--rail-h: min\(640px, calc\(var\(--osl-viewport-height\) - var\(--osl-panel-top\) - var\(--osl-footer-height\)/);
  assert.match(source.index, /footer\.controls \{[^}]*min-height: var\(--osl-shell-footer-height\)/);
}

const source = Object.fromEntries(await Promise.all(
  Object.entries(paths).map(async ([key, file]) => [key, await readFile(file, "utf8")])
));
validateSources(source);

const mutations = [
  ["hosted-footer-label-regresses", (value) => ({
    ...value,
    index: replaceOnce(value.index, ">lab.openspatials.com</a>", ">https://lab.openspatials.com/</a>"),
  })],
  ["old-hosted-address-returns", (value) => ({
    ...value,
    launcher: replaceOnce(value.launcher, 'hostedLink.href = "https://lab.openspatials.com/";', 'hostedLink.href = "https://labs.peers.social/open-spatial-lab/";'),
  })],
  ["footer-attribution-removed", (value) => ({
    ...value,
    index: replaceOnce(value.index, ATTRIBUTION, "Open Spatial Lab"),
  })],
  ["launcher-attribution-not-in-dock", (value) => ({
    ...value,
    launcher: replaceOnce(value.launcher, "dock.append(attribution, hostedLink);", "dock.append(hostedLink);"),
  })],
  ["dashboard-attribution-removed", (value) => ({
    ...value,
    dashboard: replaceOnce(value.dashboard, ATTRIBUTION, "Open Spatial Lab"),
  })],
  ["noscript-attribution-removed", (value) => ({
    ...value,
    noscript: replaceOnce(value.noscript, ATTRIBUTION, "Open Spatial Lab"),
  })],
  ["footer-hosted-class-regresses", (value) => ({
    ...value,
    index: replaceOnce(value.index, "footer-hosted-link", "footer-order-regressed"),
  })],
  ["github-footer-link-returns", (value) => ({
    ...value,
    index: replaceOnce(
      value.index,
      '<span class="footer-links">',
      '<span class="footer-links"><a class="footer-link footer-github-link" href="https://github.com/openspatials/open-spatial-lab">github.com/openspatials/open-spatial-lab</a>',
    ),
  })],
  ["footer-centering-regresses", (value) => ({
    ...value,
    index: replaceOnce(
      value.index,
      '.footer-links { width: 100%; min-width: 0; display: flex; align-items: center; justify-content: center;',
      '.footer-links { width: 100%; min-width: 0; display: flex; align-items: center; justify-content: flex-start;',
    ),
  })],
  ["footer-system-sans-regresses", (value) => ({
    ...value,
    index: replaceOnce(
      value.index,
      "color: var(--launcher-cyan, #63d8ff); font-family: inherit;",
      "color: var(--launcher-cyan, #63d8ff); font-family: var(--launcher-mono, ui-monospace, Menlo, monospace);",
    ),
  })],
  ["panel-ignores-measured-footer", (value) => ({
    ...value,
    index: replaceOnce(value.index, "- var(--osl-panel-top) - var(--osl-footer-height) - var(--osl-glass-edge)));", "- var(--osl-panel-top) - var(--osl-shell-footer-height) - var(--osl-glass-edge)));"),
  })],
  ["footer-readable-size-regresses", (value) => ({
    ...value,
    index: replaceOnce(value.index, "font-size: clamp(17px, 5vw, 21px);", "font-size: 10.5px;"),
  })],
  ["footer-decoration-returns", (value) => ({
    ...value,
    index: replaceOnce(value.index, '<span class="footer-links">', '<span class="footer-github-mark">&gt;_</span><span class="footer-links">'),
  })],
  ["narrow-footer-wrap-lost", (value) => ({
    ...value,
    index: replaceOnce(
      value.index,
      "overflow-wrap: anywhere; text-align: center; text-decoration: none;",
      "white-space: nowrap; text-align: center; text-decoration: none;",
    ),
  })],
];

const controlledRed = [];
for (const [name, mutate] of mutations) {
  let rejected = false;
  try { validateSources(mutate(source)); }
  catch { rejected = true; }
  assert.equal(rejected, true, `${name} mutation must turn RED`);
  controlledRed.push(name);
}

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  positive: "server camera icon and centered hosted footer contract",
  controlled_red: controlledRed,
}, null, 2)}\n`);

const { check, finish } = nodeChecks("server-camera");
await check("server-view-toggle", "The server view's camera button is the header's icon button, named, stateful and wordless", serverViewToggle);
await finish({ checkFile: "src/server-camera-footer-check.mjs", faults: serverViewFaults });
