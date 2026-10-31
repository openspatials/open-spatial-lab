// What the camera and movement checks read from the page beyond kit.mjs's pageFacts. Every read of the demo's insides for
// these checks is here, so that a move of the code changes one place.
import { sleep } from "./kit.mjs";

/** The header and footer controls, the body's marks, and what the visitor wears. */
export function cameraPageFacts(page) {
  return page.evaluate(() => {
    const dataset = document.body.dataset;
    const header = document.getElementById("btn-camera-toggle");
    const footer = document.querySelector("footer.controls");
    const returnButton = document.getElementById("btn-return-lobby");
    const debug = window.__assembly.debugState();
    return {
      headerCameraPressed: header ? header.getAttribute("aria-pressed") : null,
      mission: dataset.denverSkyportMission || null,
      apertureMarks: Object.keys(dataset).filter((name) => /aperture.*entities/i.test(name)),
      worn: debug.avatar && Array.isArray(debug.avatar.equippedItems) ? debug.avatar.equippedItems.length : null,
      footerPublished: document.documentElement.style.getPropertyValue("--osl-footer-measured"),
      footerHeight: footer ? footer.getBoundingClientRect().height : null,
      returnDisabled: returnButton ? returnButton.disabled : null,
    };
  });
}

/** Make the footer taller, as a footer that wraps to more lines is. */
export const growFooter = (page, px) => page.evaluate((height) => { document.querySelector("footer.controls").style.height = `${height}px`; }, px);

export const pressHeaderCamera = (page) => page.click("#btn-camera-toggle");
export const pressReturnToLobby = (page) => page.evaluate(() => document.getElementById("btn-return-lobby").click());

/** The avatar selector as a person uses it: open it, choose no equipment, apply. Returns once the choice has been applied. */
export async function chooseNoEquipment(page) {
  await page.evaluate(() => document.querySelector('[data-testid="btn-switch-avatar"]').click());
  await page.waitForSelector('[data-testid="avatar-selector-equipment-none"]', { timeout: 60000 });
  await page.click('[data-testid="avatar-selector-equipment-none"]');
  await page.click('[data-testid="avatar-selector-apply"]');
  await sleep(1500);
}
