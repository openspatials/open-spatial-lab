import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 18332;
const base = `http://127.0.0.1:${port}`;
const evidenceRoot = path.join(
  root,
  "diagnostics",
);
const holdServer = process.argv.includes("--hold-server");
const pageUrl = `${base}/index.html?role=source&wow=./worlds/denver-skyport.json&intro=0`;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForFrontend() {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/index.html`);
      if (response.ok) return;
      lastError = new Error(`frontend HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError || new Error("frontend did not become ready");
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000),
  ]);
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  return true;
}

async function main() {
  await mkdir(evidenceRoot, { recursive: true });
  const frontendLogPath = path.join(evidenceRoot, "frontend-18332.log");
  const frontendLog = createWriteStream(frontendLogPath, { flags: "w" });
  const frontend = spawn(process.execPath, [path.join(root, "src/serve.js"), String(port)], {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  frontend.stdout.pipe(frontendLog);
  frontend.stderr.pipe(frontendLog);
  await writeFile(path.join(evidenceRoot, "frontend-18332.pid"), `${frontend.pid}\n`, "utf8");

  const diagnostics = {
    version_id: "runtime",
    started_at: new Date().toISOString(),
    url: pageUrl,
    port,
    headed: true,
    profiles: {},
    console: { warnings: [], errors: [], page_errors: [], request_failures: [] },
    identity: {},
    cleanup: { browser: false, frontend: false, port_released: false },
  };
  let browser = null;
  let failure = null;

  try {
    await waitForFrontend();
    const { findBrowser } = await import(path.join(root, "tools/find-browser.mjs"));
    const executablePath = findBrowser();
    assert.ok(executablePath, "headed validation requires local Chrome/Chromium");
    diagnostics.browser_executable = executablePath;
    const puppeteer = require("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      args: [
        "--no-sandbox",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--window-size=1440,900",
      ],
    });
    await writeFile(path.join(evidenceRoot, "headed-browser.pid"), `${browser.process()?.pid || "unknown"}\n`, "utf8");
    const page = await browser.newPage();
    page.on("console", (message) => {
      const type = message.type();
      if (type === "warning") diagnostics.console.warnings.push(message.text());
      if (type === "error") diagnostics.console.errors.push(message.text());
    });
    page.on("pageerror", (error) => diagnostics.console.page_errors.push(error.message));
    page.on("requestfailed", (request) => diagnostics.console.request_failures.push({
      url: request.url(),
      error: request.failure()?.errorText || "request failed",
    }));

    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem("osl-floating-panel-size-v1", JSON.stringify({ width: 777, height: 666 }));
    });
    await page.goto(pageUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction(
      () => document.body.dataset.wowReady === "1" && window.__assembly?.chrome?.snapshot,
      { timeout: 30000 },
    );
    await page.evaluate(() => {
      window.__wo232OwnerIdentity = window.__assembly.chrome.owner();
      window.__wo232RendererIdentity = window.__wow.renderIdentity();
      window.__wo232CanvasIdentity = document.querySelector("#scene-mount > canvas");
    });

    const readTruth = () => page.evaluate(() => {
      const chrome = window.__assembly.chrome.snapshot();
      const panel = document.querySelector("aside.rail");
      const menu = document.querySelector("header.role-banner");
      const panelStyle = getComputedStyle(panel);
      const menuStyle = getComputedStyle(menu);
      return {
        ...chrome,
        page: {
          scroll_width: document.documentElement.scrollWidth,
          scroll_height: document.documentElement.scrollHeight,
          client_width: document.documentElement.clientWidth,
          client_height: document.documentElement.clientHeight,
        },
        overflow: {
          panel_scroll_height: panel.scrollHeight,
          panel_client_height: panel.clientHeight,
          panel_overflow_y: panelStyle.overflowY,
        },
        styles: {
          panel_position: panelStyle.position,
          panel_background: panelStyle.backgroundColor,
          panel_backdrop_filter: panelStyle.backdropFilter || panelStyle.webkitBackdropFilter,
          menu_background: menuStyle.backgroundColor,
          menu_backdrop_filter: menuStyle.backdropFilter || menuStyle.webkitBackdropFilter,
          menu_border_radius: menuStyle.borderRadius,
          panel_border_radius: panelStyle.borderRadius,
        },
      };
    });

    const initial = await readTruth();
    assert.equal(initial.open, true);
    assert.equal(initial.size_mode, "auto");
    assert.equal(initial.dock, "right");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("osl-floating-panel-size-v1") === null), true);
    assert.ok(Math.abs(initial.menu.left - 12) <= 1 && Math.abs(initial.menu.right - 1428) <= 1);
    assert.ok(Math.abs(initial.panel.right - 1428) <= 1, "auto panel must right-dock at safe inset");
    assert.equal(initial.canvas.width, 1440);
    assert.equal(initial.canvas.height, 900);
    assert.ok(initial.page.scroll_width <= initial.page.client_width && initial.page.scroll_height <= initial.page.client_height);
    diagnostics.profiles.desktop_initial = initial;
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-initial-auto-dock.png") });

    await page.evaluate(() => window.__assembly.chrome.setSize(520, 520));
    await page.waitForFunction(() => window.__assembly.chrome.snapshot().size_mode === "manual");
    const manual = await readTruth();
    assert.equal(manual.panel.width, 520);
    assert.equal(manual.panel.height, 520);
    assert.ok(Math.abs(manual.panel.right - 1428) <= 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("osl-floating-panel-size-v1") === null), true);
    diagnostics.profiles.desktop_manual = manual;
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-manual-size.png") });

    const dragStart = await page.$eval(".panel-control-strip", (element) => element.getBoundingClientRect().toJSON());
    await page.mouse.move(dragStart.left + 80, dragStart.top + 20);
    await page.mouse.down();
    await page.mouse.move(dragStart.left - 120, dragStart.top + 70, { steps: 8 });
    await page.mouse.up();
    const dragged = await readTruth();
    assert.ok(dragged.panel.left < manual.panel.left - 150, "Inspector header drag must move the panel horizontally");
    assert.ok(dragged.panel.top > manual.panel.top + 30, "Inspector header drag must move the panel vertically");
    assert.equal(dragged.dock, "free");
    diagnostics.profiles.desktop_dragged = dragged;
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-panel-dragged.png") });

    await page.click("#btn-panel-close");
    await page.waitForFunction(() => window.__assembly.chrome.snapshot().open === false);
    diagnostics.profiles.closed = await readTruth();
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-panel-closed.png") });
    await page.click("#btn-rail-toggle");
    await page.waitForFunction(() => window.__assembly.chrome.snapshot().open === true);
    const reopened = await readTruth();
    assert.equal(reopened.size_mode, "auto");
    assert.equal(reopened.dock, "right");
    assert.equal(reopened.panel.width, initial.panel.width);
    assert.equal(reopened.panel.height, initial.panel.height);
    assert.equal(reopened.panel.left, initial.panel.left);
    assert.equal(reopened.panel.top, initial.panel.top);
    const identityAfterReopen = await page.evaluate(() => ({
      same_owner: window.__assembly.chrome.owner() === window.__wo232OwnerIdentity,
      same_renderer: window.__wow.renderIdentity() === window.__wo232RendererIdentity,
      same_canvas: document.querySelector("#scene-mount > canvas") === window.__wo232CanvasIdentity,
      mount_count: window.__assembly.chrome.snapshot().mount_count,
    }));
    assert.deepEqual(identityAfterReopen, { same_owner: true, same_renderer: true, same_canvas: true, mount_count: 1 });
    diagnostics.identity.after_reopen = identityAfterReopen;
    diagnostics.profiles.reopened = reopened;
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-panel-reopened.png") });

    await page.setViewport({ width: 900, height: 650, deviceScaleFactor: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction(() => document.documentElement.getBoundingClientRect().width === 900);
    const shrunk = await readTruth();
    diagnostics.profiles.live_viewport_shrink = shrunk;
    assert.ok(Math.abs(shrunk.panel.right - 888) <= 1, `shrink right dock ${JSON.stringify(shrunk.panel)}`);
    assert.ok(shrunk.panel.bottom <= 594, "manual panel must clamp above the footer");
    assert.equal(shrunk.preferred_size, null);
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-live-viewport-shrink.png") });

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction(() => document.documentElement.getBoundingClientRect().width === 1440);
    const regrown = await readTruth();
    assert.equal(regrown.panel.width, initial.panel.width);
    assert.equal(regrown.panel.height, initial.panel.height);
    assert.ok(Math.abs(regrown.panel.right - 1428) <= 1);
    diagnostics.profiles.live_viewport_regrow = regrown;

    const beforeKeyboard = await readTruth();
    await page.focus("#rail-resizer");
    await page.keyboard.press("ArrowRight");
    await page.focus("#panel-height-resizer");
    await page.keyboard.press("ArrowUp");
    const keyboardSize = await readTruth();
    assert.equal(keyboardSize.panel.width, beforeKeyboard.panel.width - 24);
    assert.equal(keyboardSize.panel.height, beforeKeyboard.panel.height - 24);
    diagnostics.profiles.keyboard_resize = keyboardSize;

    await page.evaluate(() => {
      window.__assembly.panelGroups.setExpanded("standards", true);
      window.__assembly.panelGroups.setExpanded("runtime", true);
      document.querySelector("aside.rail").scrollTop = 180;
    });
    const overflow = await readTruth();
    assert.ok(overflow.overflow.panel_scroll_height > overflow.overflow.panel_client_height);
    assert.equal(overflow.overflow.panel_overflow_y, "auto");
    assert.ok(overflow.page.scroll_width <= overflow.page.client_width && overflow.page.scroll_height <= overflow.page.client_height);
    diagnostics.profiles.internal_overflow = overflow;
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-internal-overflow.png") });

    await page.setViewport({ width: 480, height: 760, deviceScaleFactor: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction(() => document.documentElement.getBoundingClientRect().width === 480);
    const narrow = await readTruth();
    const narrowMenu = await page.evaluate(() => {
      const header = document.querySelector("header.role-banner");
      const visible = [...header.children].filter((element) => {
        const rectangle = element.getBoundingClientRect();
        return getComputedStyle(element).display !== "none" && rectangle.width > 1 && rectangle.height > 1;
      });
      const bounds = visible.map((element) => ({ id: element.id || element.className, ...element.getBoundingClientRect().toJSON() }));
      return {
        scroll_width: header.scrollWidth,
        client_width: header.clientWidth,
        bounds,
        no_overlap: bounds.every((entry, index) => index === 0 || entry.left >= bounds[index - 1].right - 0.5),
      };
    });
    assert.ok(Math.abs(narrow.menu.left - 8) <= 1 && Math.abs(narrow.menu.right - 472) <= 1);
    assert.ok(Math.abs(narrow.panel.right - 472) <= 1);
    assert.ok(narrow.panel.width <= 464);
    assert.ok(narrowMenu.scroll_width <= narrowMenu.client_width);
    assert.equal(narrowMenu.no_overlap, true);
    diagnostics.profiles.narrow = { ...narrow, menu_layout: narrowMenu };
    await page.screenshot({ path: path.join(evidenceRoot, "narrow-right-docked.png") });

    await page.evaluate(() => window.__assembly.chrome.setBlurEnabled(false));
    const noBlur = await readTruth();
    assert.equal(noBlur.blur, "off");
    assert.equal(noBlur.styles.panel_backdrop_filter, "none");
    assert.notEqual(noBlur.styles.panel_background, "rgba(0, 0, 0, 0)");
    diagnostics.profiles.no_blur = noBlur;
    await page.screenshot({ path: path.join(evidenceRoot, "narrow-no-blur-fallback.png") });

    await page.evaluate(() => window.__assembly.chrome.setReducedTransparency(true));
    await page.focus("#btn-panel-close");
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return { id: active.id, outline_style: style.outlineStyle, outline_width: style.outlineWidth };
    });
    assert.equal(focus.id, "btn-panel-close");
    assert.notEqual(focus.outline_style, "none");
    diagnostics.profiles.focus = focus;
    await page.screenshot({ path: path.join(evidenceRoot, "narrow-keyboard-focus.png") });

    await page.evaluate(() => window.__assembly.chrome.resetSize());
    await page.waitForFunction(() => window.__assembly.chrome.snapshot().size_mode === "auto");
    const pointerTruth = await page.evaluate(() => {
      const scene = document.querySelector("#scene-mount");
      let scenePointerCount = 0;
      scene.addEventListener("pointerdown", () => { scenePointerCount += 1; }, { once: true });
      const outside = document.elementFromPoint(40, 300);
      outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 300 }));
      const panel = document.querySelector("aside.rail");
      const panelRect = panel.getBoundingClientRect();
      const insidePanel = document.elementFromPoint(panelRect.left + 30, panelRect.top + 30);
      const menuRect = document.querySelector("header.role-banner").getBoundingClientRect();
      const insideMenu = document.elementFromPoint(menuRect.left + 30, menuRect.top + 30);
      return {
        outside_tag: outside.tagName,
        outside_in_scene: scene.contains(outside),
        outside_in_chrome: !!outside.closest("header.role-banner, aside.rail, .rail-resizer, .panel-height-resizer"),
        scene_pointer_count: scenePointerCount,
        panel_hit: panel.contains(insidePanel),
        menu_hit: document.querySelector("header.role-banner").contains(insideMenu),
      };
    });
    assert.deepEqual(pointerTruth, {
      outside_tag: pointerTruth.outside_tag,
      outside_in_scene: true,
      outside_in_chrome: false,
      scene_pointer_count: 1,
      panel_hit: true,
      menu_hit: true,
    });
    diagnostics.pointer_truth = pointerTruth;

    const finalIdentity = await page.evaluate(() => ({
      same_owner: window.__assembly.chrome.owner() === window.__wo232OwnerIdentity,
      same_renderer: window.__wow.renderIdentity() === window.__wo232RendererIdentity,
      same_canvas: document.querySelector("#scene-mount > canvas") === window.__wo232CanvasIdentity,
      mount_count: window.__assembly.chrome.snapshot().mount_count,
      listener_count: window.__assembly.chrome.snapshot().listener_count,
    }));
    assert.equal(finalIdentity.same_owner, true);
    assert.equal(finalIdentity.same_renderer, true);
    assert.equal(finalIdentity.same_canvas, true);
    assert.equal(finalIdentity.mount_count, 1);
    diagnostics.identity.final = finalIdentity;

    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction(() => document.documentElement.getBoundingClientRect().width === 1440);
    await page.evaluate(() => {
      window.__assembly.chrome.setSize(500, 420);
      sessionStorage.setItem("osl-floating-panel-size-v1", JSON.stringify({ width: 777, height: 666 }));
    });
    const reloadDragStart = await page.$eval(".panel-control-strip", (element) => element.getBoundingClientRect().toJSON());
    await page.mouse.move(reloadDragStart.left + 70, reloadDragStart.top + 18);
    await page.mouse.down();
    await page.mouse.move(reloadDragStart.left - 90, reloadDragStart.top + 50, { steps: 6 });
    await page.mouse.up();
    await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction(
      () => document.body.dataset.wowReady === "1" && window.__assembly?.chrome?.snapshot,
      { timeout: 30000 },
    );
    const reloaded = await readTruth();
    assert.equal(reloaded.open, true);
    assert.equal(reloaded.size_mode, "auto");
    assert.equal(reloaded.dock, "right");
    assert.equal(reloaded.panel.width, initial.panel.width);
    assert.equal(reloaded.panel.height, initial.panel.height);
    assert.equal(reloaded.panel.left, initial.panel.left);
    assert.equal(reloaded.panel.top, initial.panel.top);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("osl-floating-panel-size-v1") === null), true);
    diagnostics.profiles.reload_reset = reloaded;
    await page.screenshot({ path: path.join(evidenceRoot, "desktop-reload-reset.png") });

    assert.deepEqual(diagnostics.console.warnings, []);
    assert.deepEqual(diagnostics.console.errors, []);
    assert.deepEqual(diagnostics.console.page_errors, []);
    const unexpectedRequestFailures = diagnostics.console.request_failures.filter((entry) => entry.error !== "net::ERR_ABORTED");
    assert.deepEqual(unexpectedRequestFailures, []);
    diagnostics.status = "PASS";
  } catch (error) {
    failure = error;
    diagnostics.status = "RED";
    diagnostics.error = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    if (browser) {
      try { await browser.close(); diagnostics.cleanup.browser = true; }
      catch (error) { diagnostics.cleanup.browser_error = error.message; }
    } else diagnostics.cleanup.browser = true;
  }

  if (failure) {
    await stopChild(frontend);
    diagnostics.cleanup.frontend = true;
  } else if (holdServer) {
    diagnostics.agent_browser_window = "ready";
    await writeFile(path.join(evidenceRoot, "headed-e2e.json"), `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
    process.stdout.write(`feature_E2E_READY_AGENT_BROWSER url=${pageUrl} diagnostics=${evidenceRoot}\n`);
    await new Promise((resolve) => {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await stopChild(frontend);
        diagnostics.cleanup.frontend = true;
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } else {
    await stopChild(frontend);
    diagnostics.cleanup.frontend = true;
  }

  frontendLog.end();
  diagnostics.cleanup.port_released = diagnostics.cleanup.frontend;
  diagnostics.completed_at = new Date().toISOString();
  await writeFile(path.join(evidenceRoot, "headed-e2e.json"), `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  await writeFile(path.join(evidenceRoot, "process-cleanup.json"), `${JSON.stringify(diagnostics.cleanup, null, 2)}\n`, "utf8");
  process.stdout.write(`feature_HEADED_E2E ${diagnostics.status} diagnostics=${path.join(evidenceRoot, "headed-e2e.json")}\n`);
  if (failure) throw failure;
}

await main();
