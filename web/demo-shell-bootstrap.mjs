import { mountDemoLauncher, parseIntroPreference } from "./demo-launcher.mjs";

const mount = document.getElementById("demo-launcher-mount");
const app = document.getElementById("app");
const viewsButton = document.getElementById("btn-views-home");
const introPreference = parseIntroPreference(location.href);
const url = new URL(location.href);
const nonIntroParams = [...url.searchParams.keys()].filter((key) => key !== "intro");
const isBareEntry = nonIntroParams.length === 0 && !url.hash;
let teardownLauncher = null;
let appStarted = false;

function hideLauncher({ restoreFocus = false } = {}) {
  if (teardownLauncher) teardownLauncher();
  teardownLauncher = null;
  mount.scrollTop = 0;
  mount.hidden = true;
  app.hidden = false;
  viewsButton?.setAttribute("aria-expanded", "false");
  // dismissing the HOME launcher returns to the running
  // app, so re-register presence + restart the heartbeat (symmetric with
  // showLauncher's leaveSession) so the server tracks this player again. No-ops
  // before the app has booted: the initial startApp() hides the launcher before
  // app.js is imported, so window.__assembly is absent and this optional-chains
  // away (the boot's own "spawn" registration is the sole first registration).
  void window.__assembly?.adapter?.resumeSession?.("resume_from_home");
  if (restoreFocus) viewsButton?.focus();
}

function showLauncher({ dismissible = appStarted } = {}) {
  if (teardownLauncher) teardownLauncher();
  if (appStarted) {
    window.dispatchEvent(new Event("blur"));
    // the HOME button hides the app in-DOM; it must ALSO
    // leave the live session so the server stops counting this player. Without
    // this, the 3s presence heartbeat keeps refreshing the TTL and lobby/room
    // occupancy only ever climbs (the reported leak). leaveSession stops
    // the heartbeat and fires a sendBeacon depart synchronously, before we hide.
    void window.__assembly?.adapter?.leaveSession?.("home_button");
  }
  mount.hidden = false;
  app.hidden = true;
  viewsButton?.setAttribute("aria-expanded", "true");
  teardownLauncher = mountDemoLauncher(mount, {
    airportAvailable: true,
    onDismiss: dismissible ? () => hideLauncher({ restoreFocus: true }) : undefined,
    // This opens the real player lobby. The visitor still crosses Portal C;
    // the launcher never invents a direct airport backend or teleport.
    launchPortalC: () => location.assign("./index.html?role=player&mission=denver-skyport"),
  });
  mount.scrollTop = 0;
  const launcher = mount.querySelector(".demo-launcher");
  if (launcher) {
    launcher.tabIndex = -1;
    launcher.focus({ preventScroll: true });
  }
}

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  hideLauncher();
  await import("./app.js?v=1");
}

viewsButton?.setAttribute("aria-expanded", "false");
viewsButton?.addEventListener("click", () => showLauncher({ dismissible: true }));

if (introPreference === "force" || (introPreference !== "bypass" && isBareEntry)) {
  showLauncher({ dismissible: false });
} else {
  await startApp();
}
