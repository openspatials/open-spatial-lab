#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  index: path.join(ROOT, "web", "index.html"),
  camera: path.join(ROOT, "web", "movement-camera-controller.mjs"),
  app: path.join(ROOT, "web", "app.js"),
};

function replaceOnce(value, before, after) {
  assert.ok(value.includes(before), `mutation target missing: ${before}`);
  return value.replace(before, after);
}

function validateSources(source) {
  assert.match(source.index, /id="btn-camera-toggle"[\s\S]*?<svg class="header-action-icon"/);
  assert.match(source.camera, /const sharedToggle = lookup\("btn-camera-toggle"\)/);
  assert.match(source.camera, /serverViewModeButton\.hidden = false/);
  assert.match(source.camera, /serverViewModeButton\.setAttribute\("aria-label", actionLabel\)/);
  assert.match(source.camera, /serverViewModeButton\.title = actionLabel/);
  assert.match(source.camera, /serverViewModeButton\.setAttribute\("aria-pressed", String\(serverViewCamera\.mode === "top_down"\)\)/);
  assert.doesNotMatch(source.camera, /serverViewModeButton\.textContent\s*=/);
  assert.doesNotMatch(source.camera, /createElement\("button"\)[\s\S]{0,500}btn-server-camera-mode/);
  assert.doesNotMatch(source.camera, /View: top-down|View: 3rd person/);
  assert.match(source.app, /if \(cameraToggleBtn && isPlayer\)/);
  assert.match(source.app, /movementCameraController\.togglePlayerCameraMode\(\)/);

  const footer = source.index.match(/<span class="footer-links">([\s\S]*?)<\/span>\s*<\/footer>/)?.[1] || "";
  const anchors = [...footer.matchAll(/<a class="footer-link ([^"]+)" href="([^"]+)"[\s\S]*?>([^<]+)<\/a>/g)]
    .map((match) => ({ className: match[1], href: match[2], label: match[3].trim() }));
  assert.deepEqual(anchors, [
    {
      className: "footer-hosted-link",
      href: "https://labs.peers.social/open-spatial-lab/",
      label: "labs.peers.social/open-spatial-lab",
    },
  ]);
  assert.doesNotMatch(footer, />_|↗|footer-github-mark|footer-github-link|github\.com\/grigb\/open-spatial-lab/);
  assert.doesNotMatch(source.index, /class="footer-github-mark"/);
  assert.match(source.index, /\.footer-links \{[^}]*width: 100%[^}]*justify-content: center/);
  assert.match(source.index, /\.footer-link \{[^}]*max-width: 100%[^}]*font-family: inherit[^}]*font-size: clamp\(17px, 5vw, 21px\)[^}]*font-weight: 600[^}]*line-height: 1\.2[^}]*overflow-wrap: anywhere[^}]*text-align: center/s);
  assert.doesNotMatch(source.index, /\.footer-(?:hosted|github)-link \{[^}]*margin-(?:left|right): auto/);
}

const source = Object.fromEntries(await Promise.all(
  Object.entries(paths).map(async ([key, file]) => [key, await readFile(file, "utf8")])
));
validateSources(source);

const mutations = [
  ["server-reverts-to-text-button", (value) => ({
    ...value,
    camera: replaceOnce(value.camera, 'const sharedToggle = lookup("btn-camera-toggle")', 'const sharedToggle = documentTarget.createElement("button")'),
  })],
  ["server-action-name-lost", (value) => ({
    ...value,
    camera: replaceOnce(value.camera, 'serverViewModeButton.setAttribute("aria-label", actionLabel);', "void actionLabel;"),
  })],
  ["server-visible-text-returns", (value) => ({
    ...value,
    camera: replaceOnce(value.camera, "serverViewModeButton.title = actionLabel;", 'serverViewModeButton.textContent = "View: 3rd person";'),
  })],
  ["hosted-footer-label-regresses", (value) => ({
    ...value,
    index: replaceOnce(value.index, ">labs.peers.social/open-spatial-lab</a>", ">https://labs.peers.social/open-spatial-lab/</a>"),
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
