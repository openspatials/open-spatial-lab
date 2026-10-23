import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mutation = process.argv.find((argument) => argument.startsWith("--mutate="))?.slice(9) || "";
const mutationIds = Object.freeze([
  "overflow-hidden",
  "fixed-100vh-clipping",
  "touch-action-none",
  "wheel-prevent-default",
  "leaked-close-state-lock",
  "unreachable-bottom-control",
  "technology-section-before-missions",
  "narrow-dock-clearance-clipped",
]);

const source = Object.freeze({
  css: await readFile(path.join(root, "web/demo-launcher.css"), "utf8"),
  launcher: await readFile(path.join(root, "web/demo-launcher.mjs"), "utf8"),
  bootstrap: await readFile(path.join(root, "web/demo-shell-bootstrap.mjs"), "utf8"),
  preview: await readFile(path.join(root, "web/demo-launcher-preview.html"), "utf8"),
  index: await readFile(path.join(root, "web/index.html"), "utf8"),
});

function replaceRequired(value, before, after, label) {
  assert(value.includes(before), `controlled mutation anchor missing: ${label}`);
  return value.replace(before, after);
}

function mutate(input, id) {
  const candidate = { ...input };
  if (id === "overflow-hidden") {
    candidate.css = replaceRequired(candidate.css, "  overflow-y: auto;", "  overflow-y: hidden;", id);
  } else if (id === "fixed-100vh-clipping") {
    candidate.css = replaceRequired(
      candidate.css,
      "  height: 100%;\n  overflow-y: auto;",
      "  height: 100vh;\n  max-height: 100vh;\n  overflow-y: auto;",
      id,
    );
  } else if (id === "touch-action-none") {
    candidate.css = replaceRequired(
      candidate.css,
      "  overflow-y: auto;",
      "  overflow-y: auto;\n  touch-action: none;",
      id,
    );
  } else if (id === "wheel-prevent-default") {
    candidate.launcher = replaceRequired(
      candidate.launcher,
      "  root.addEventListener(\"keydown\", handleLauncherKey);",
      "  root.addEventListener(\"wheel\", (event) => event.preventDefault(), { passive: false });\n  root.addEventListener(\"keydown\", handleLauncherKey);",
      id,
    );
  } else if (id === "leaked-close-state-lock") {
    candidate.bootstrap = replaceRequired(candidate.bootstrap, "  app.hidden = false;", "  app.hidden = true;", id);
  } else if (id === "unreachable-bottom-control") {
    candidate.launcher = replaceRequired(
      candidate.launcher,
      "    groupSections.get(mission.launcherGroup).append(button);",
      "    if (mission.launcherGroup !== \"destinations\") groupSections.get(mission.launcherGroup).append(button);",
      id,
    );
  } else if (id === "technology-section-before-missions") {
    candidate.launcher = replaceRequired(
      candidate.launcher,
      "  shell.append(header, missionSection, technologySection, liveRegion);",
      "  shell.append(header, technologySection, missionSection, liveRegion);",
      id,
    );
  } else if (id === "narrow-dock-clearance-clipped") {
    candidate.css = replaceRequired(candidate.css, "    padding: 18px 14px 112px;", "    padding: 18px 14px 64px;", id);
  } else if (id) {
    throw new Error(`Unknown runtime mutation: ${id}`);
  }
  return candidate;
}

function ruleBody(value, selector) {
  const selectorIndex = value.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `missing CSS rule: ${selector}`);
  const openIndex = value.indexOf("{", selectorIndex);
  const closeIndex = value.indexOf("}", openIndex);
  assert(openIndex > selectorIndex && closeIndex > openIndex, `incomplete CSS rule: ${selector}`);
  return value.slice(openIndex + 1, closeIndex);
}

function verify(candidate) {
  const checks = [];
  const check = (label, callback) => {
    callback();
    checks.push(label);
  };

  check("integrated mount is the sole intentional vertical scroll owner", () => {
    const owners = candidate.css.match(/overflow-y:\s*auto;/g) || [];
    assert.equal(owners.length, 1);
    const mount = ruleBody(candidate.css, "#demo-launcher-mount.demo-launcher-root");
    assert.match(mount, /height:\s*100%;/);
    assert.match(mount, /overflow-y:\s*auto;/);
    assert.match(mount, /overscroll-behavior:\s*contain;/);
    assert.doesNotMatch(mount, /max-height:\s*100vh/);
  });

  check("touch scrolling remains native", () => {
    const mount = ruleBody(candidate.css, "#demo-launcher-mount.demo-launcher-root");
    assert.doesNotMatch(mount, /touch-action:\s*none/);
    assert.doesNotMatch(candidate.launcher, /addEventListener\(["']touchmove["'][\s\S]{0,160}preventDefault/);
  });

  check("wheel and trackpad gestures are not cancelled", () => {
    assert.doesNotMatch(candidate.launcher, /addEventListener\(["']wheel["'][\s\S]{0,160}preventDefault/);
  });

  check("launcher keyboard input cannot leak into hidden world controls", () => {
    const handler = candidate.launcher.match(/function handleLauncherKey\(event\) \{([\s\S]*?)\n  \}\n  root\.addEventListener/);
    assert(handler, "missing existing launcher key owner");
    assert.match(handler[1], /event\.stopPropagation\(\);/);
    assert(handler[1].indexOf("event.stopPropagation();") < handler[1].indexOf("launcherKeyAction("));
  });

  check("integrated open and close states release each other", () => {
    const close = candidate.bootstrap.match(/function hideLauncher[\s\S]*?\n\}/)?.[0] || "";
    const open = candidate.bootstrap.match(/function showLauncher[\s\S]*?\n\}/)?.[0] || "";
    assert.match(close, /mount\.scrollTop = 0;/);
    assert.match(close, /mount\.hidden = true;/);
    assert.match(close, /app\.hidden = false;/);
    assert.match(open, /mount\.hidden = false;/);
    assert.match(open, /app\.hidden = true;/);
    assert.match(open, /mount\.scrollTop = 0;/);
    assert.match(open, /window\.dispatchEvent\(new Event\("blur"\)\);/);
  });

  check("integrated launcher receives initial keyboard focus", () => {
    assert.match(candidate.bootstrap, /launcher\.tabIndex = -1;/);
    assert.match(candidate.bootstrap, /launcher\.focus\(\{ preventScroll: true \}\);/);
    assert.match(candidate.bootstrap, /hideLauncher\(\{ restoreFocus: true \}\)/);
  });

  check("standalone preview keeps document scrolling", () => {
    const body = ruleBody(candidate.css, ".demo-launcher-preview-body");
    assert.doesNotMatch(body, /overflow-y:\s*(?:hidden|clip)/);
    assert.match(candidate.preview, /class="demo-launcher-preview-body"/);
  });

  check("fixed integrated document delegates only to the launcher mount", () => {
    assert.match(candidate.index, /html, body \{[\s\S]*?overflow: hidden;/);
    assert.match(candidate.index, /id="demo-launcher-mount" hidden/);
  });

  check("all catalog controls, including the final destination, are appended", () => {
    assert.match(candidate.launcher, /groupSections\.get\(mission\.launcherGroup\)\.append\(button\);/);
    assert.doesNotMatch(candidate.launcher, /mission\.launcherGroup !== ["']destinations["']/);
  });

  check("complete mission launcher precedes the complete technology register in DOM and heading read order", () => {
    const occurrenceCount = (pattern) => candidate.launcher.match(pattern)?.length || 0;
    assert.equal(occurrenceCount(/const missionSection = doc\.createElement\("section"\);/g), 1);
    assert.equal(occurrenceCount(/const technologySection = doc\.createElement\("section"\);/g), 1);
    assert.equal(occurrenceCount(/missionTitle\.textContent = "Ready to explore\?";/g), 1);
    assert.equal(occurrenceCount(/technologyTitle\.textContent = "Technologies in and around the demo";/g), 1);
    assert.match(candidate.launcher, /missionSection\.id = "demo-launcher-actions";/);
    assert.match(candidate.launcher, /missionSection\.setAttribute\("aria-labelledby", "demo-launcher-missions-title"\);/);
    assert.match(candidate.launcher, /technologySection\.setAttribute\("aria-labelledby", "demo-launcher-technologies-title"\);/);
    assert.match(candidate.launcher, /missionSection\.prepend\(missionHeading\);/);
    assert.match(candidate.launcher, /technologySection\.append\(technologyHeading, technologyGrid, independence, sourceGithubLink\);/);
    assert.match(candidate.launcher, /shell\.append\(header, missionSection, technologySection, liveRegion\);/);
    assert.doesNotMatch(candidate.launcher, /shell\.append\(header, technologySection, missionSection, liveRegion\);/);
  });

  check("mission and technology content owners remain complete and nonduplicating", () => {
    assert.equal((candidate.launcher.match(/for \(const mission of catalog\)/g) || []).length, 1);
    assert.equal((candidate.launcher.match(/groupSections\.get\(mission\.launcherGroup\)\.append\(button\);/g) || []).length, 1);
    assert.equal((candidate.launcher.match(/cardButtons\.push\(button\);/g) || []).length, 1);
    assert.equal((candidate.launcher.match(/for \(const technology of technologies\)/g) || []).length, 1);
    assert.equal((candidate.launcher.match(/technologyGrid\.append\(article\);/g) || []).length, 1);
    assert.equal((candidate.launcher.match(/technologySection\.append\(technologyHeading, technologyGrid, independence, sourceGithubLink\);/g) || []).length, 1);
  });

  check("narrow hosted dock keeps focus-outline clearance below the final source link", () => {
    assert.match(candidate.css, /@media \(max-width: 680px\)[\s\S]*?\.demo-launcher \{[\s\S]*?padding:\s*18px 14px 112px;/);
  });

  return checks;
}

const checks = verify(mutate(source, mutation));
if (mutation) {
  process.stdout.write(`runtime controlled mutation unexpectedly survived: ${mutation}\n`);
  process.exitCode = 1;
} else {
  let killed = 0;
  for (const id of mutationIds) {
    assert.throws(() => verify(mutate(source, id)), { name: "AssertionError" }, `${id} mutation survived`);
    killed += 1;
  }
  process.stdout.write(`runtime homepage scroll check: PASS ${checks.length}/${checks.length}; controlled RED ${killed}/${mutationIds.length}\n`);
}
