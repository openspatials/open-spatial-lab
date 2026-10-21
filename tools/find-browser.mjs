/**
 * find-browser.mjs — locate a usable Chromium/Chrome binary for headless capture
 * WITHOUT requiring a fresh network download. Search order:
 *   1) PUPPETEER_EXECUTABLE_PATH env
 *   2) Puppeteer's own resolved executable (if it downloaded one)
 *   3) Cached Chrome-for-Testing builds under ~/.cache/puppeteer/chrome
 *   4) System Google Chrome / Chromium / Edge / Brave (macOS paths)
 * Exits with a path on stdout, or non-zero if none found.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export function findBrowser() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // cached Chrome-for-Testing builds
  const cacheChrome = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cacheChrome)) {
    const builds = readdirSync(cacheChrome)
      .filter((d) => d.startsWith("mac_arm") || d.startsWith("mac-") || d.startsWith("mac"))
      .sort()
      .reverse();
    for (const b of builds) {
      const candidate = path.join(
        cacheChrome, b, "chrome-mac-arm64",
        "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"
      );
      if (existsSync(candidate)) return candidate;
      const x64 = path.join(
        cacheChrome, b, "chrome-mac-x64",
        "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"
      );
      if (existsSync(x64)) return x64;
    }
  }

  // system browsers
  const system = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const p of system) if (existsSync(p)) return p;

  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const b = findBrowser();
  if (b) { console.log(b); process.exit(0); }
  console.error("no browser found");
  process.exit(1);
}
