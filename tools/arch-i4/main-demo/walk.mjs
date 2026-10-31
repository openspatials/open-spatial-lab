// The portal views of the main demo, from fixed spots, taken with real keyboard and mouse input. Each view is one PNG.
// Run the same script before and after a change, so the two sets are from the same spots:
//   node tools/arch-i4/main-demo/walk.mjs <folder> [first-port]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLab, launchBrowser, openPlayer, walkTo, faceYaw, sleep, state } from "./lab.mjs";

const out = resolve(process.argv[2] || "walk-out");
const first = Number(process.argv[3]) || 33520;
mkdirSync(out, { recursive: true });
const lab = createLab({ dir: out, first });

// world key, then the spots: name, x, z, the way the camera faces (radians, 0 = +Z, PI = -Z, PI/2 = +X).
const PI = Math.PI;
const WORLDS = [
  ["lobby", "index.html?role=player&intro=bypass", [
    ["lobby-all-portals", 0, 2.4, PI],
    ["lobby-portal-a-front", -2, 0.2, PI],
    ["lobby-portal-a-angle", -3.6, 0.6, PI * 0.9],
    ["lobby-portal-b-front", 2, 0.2, PI],
    ["lobby-portal-b-angle", 3.6, 0.6, -PI * 0.9],
    ["lobby-portal-c-front", 0, -1.4, PI],
  ]],
  ["a", "index.html?role=player&active=source&intro=bypass", [
    ["a-portal-b-front", 2.8, 0.2, PI],
    ["a-portal-lobby-front", -2.8, 0.2, PI],
  ]],
  ["b", "index.html?role=player&active=target&intro=bypass", [
    ["b-portal-a-front", -0.2, -2.8, PI / 2],
    ["b-portal-lobby-front", -0.2, 2.8, PI / 2],
  ]],
  ["airport", "index.html?role=player&active=airport&intro=bypass", [
    ["airport-portal-lobby-front", 0, -1.4, PI],
    ["airport-portal-lobby-angle", 2.2, -1.8, -PI * 0.85],
  ]],
];

lab.start();
const browser = await launchBrowser();
const log = [];
try {
  for (const [world, route, spots] of WORLDS) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await openPlayer(page, `${lab.front}/${route}`);
    const started = await state(page);
    log.push(`${world}: starts at ${JSON.stringify(started.position)}, location ${started.location_id}`);
    await page.screenshot({ path: join(out, `${world}-start.png`) });
    for (const [name, x, z, yaw] of spots) {
      await walkTo(page, x, z);
      await faceYaw(page, yaw);
      await sleep(1800);
      const s = await state(page);
      await page.screenshot({ path: join(out, `${name}.png`) });
      log.push(`${name}: stood at ${JSON.stringify(s.position.map((v) => Number(v.toFixed(2))))}, basis yaw ${s.basis.toFixed(2)}, location ${s.location_id}`);
    }
    if (errors.length) log.push(`${world} page errors: ${errors.join(" | ")}`);
    await page.close();
  }
} finally {
  await browser.close();
  await lab.stop();
  writeFileSync(join(out, "walk-log.txt"), `${log.join("\n")}\n`);
  console.log(log.join("\n"));
}
