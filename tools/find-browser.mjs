/**
 * find-browser.mjs — locate Chrome for Testing for headless capture and checks,
 * WITHOUT requiring a fresh network download. Only Chrome for Testing is used:
 * never a system browser (Brave, Google Chrome, Chromium, Edge), which may hold a
 * person's own profile and windows. Search order:
 *   1) PUPPETEER_EXECUTABLE_PATH env, when it names a Chrome for Testing binary
 *   2) Chrome for Testing in Puppeteer's browser cache, in the home folder
 *   3) Chrome for Testing in the Playwright browser cache, in the home folder's Library caches
 *   4) Chrome for Testing in the agent-browser cache, in the home folder
 * Throws when none is found, so no check falls back to another browser.
 * Run directly, it prints the path, or exits non-zero with the reason.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CFT_BINARY = path.join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");

/** Chrome for Testing inside one build folder, for Apple silicon or Intel. */
function chromeForTestingIn(build) {
  for (const platform of ["chrome-mac-arm64", "chrome-mac-x64"]) {
    const candidate = path.join(build, platform, CFT_BINARY);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The newest build folder in a cache that holds Chrome for Testing. */
function newestIn(cache, prefix) {
  if (!existsSync(cache)) return null;
  const builds = readdirSync(cache)
    .filter((d) => d.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const b of builds) {
    const found = chromeForTestingIn(path.join(cache, b));
    if (found) return found;
  }
  return null;
}

export function findBrowser() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    if (!fromEnv.endsWith("Google Chrome for Testing") || !existsSync(fromEnv)) {
      throw new Error(`PUPPETEER_EXECUTABLE_PATH must name an existing Chrome for Testing binary, not ${fromEnv}`);
    }
    return fromEnv;
  }

  const home = os.homedir();
  const found =
    newestIn(path.join(home, ".cache", "puppeteer", "chrome"), "mac") ||
    newestIn(path.join(home, "Library", "Caches", "ms-playwright"), "chromium-") ||
    newestIn(path.join(home, ".agent-browser", "browsers"), "");
  if (found) return found;

  throw new Error(
    "no Chrome for Testing found (looked in the Puppeteer, Playwright and agent-browser caches in the home " +
    "folder); set PUPPETEER_EXECUTABLE_PATH to a Chrome for Testing binary. " +
    "System browsers are never used.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(findBrowser());
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
