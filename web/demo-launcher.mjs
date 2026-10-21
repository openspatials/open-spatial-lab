import {
  createDemoLauncherCatalog,
  DEMO_TECHNOLOGIES,
  PRIMARY_MISSION_IDS,
  validateDemoLauncherCatalog,
  validateTechnologyShowcase,
} from "./demo-launcher-catalog.mjs";
import { createMotionPreference } from "./motion-preference.mjs";

const LAST_MISSION_KEY = "osl-demo-launcher-last-mission-v1";
const PRIMARY_RECON_KEY = "osl-demo-launcher-primary-recon-v1";

/**
 * Interpret the launcher control without changing any other URL state.
 *
 * @param {string|URL} href - Absolute or relative browser URL.
 * @returns {"force"|"bypass"|"auto"} Deterministic intro preference.
 */
export function parseIntroPreference(href) {
  const url = new URL(String(href), "http://osl.invalid/");
  const value = url.searchParams.get("intro");
  if (value === "1") return "force";
  if (value === "0") return "bypass";
  return "auto";
}

/**
 * Remove only the intro control while preserving path, other queries, and hash.
 *
 * @param {string|URL} href - Absolute or relative browser URL.
 * @returns {string} URL with the `intro` query parameter removed.
 */
export function withoutIntroPreference(href) {
  const raw = String(href);
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const url = new URL(raw, "http://osl.invalid/");
  url.searchParams.delete("intro");
  return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Return only missions that can currently be selected.
 *
 * @param {ReadonlyArray<object>} catalog - Valid launcher catalog.
 * @returns {ReadonlyArray<object>} Available entries in catalog order.
 */
export function availableMissions(catalog) {
  validateDemoLauncherCatalog(catalog);
  return catalog.filter((mission) => mission.availability === "available");
}

/**
 * Choose one available mission using an injected random source for testability.
 *
 * @param {ReadonlyArray<object>} catalog - Valid launcher catalog.
 * @param {() => number} [random] - Value in the half-open interval [0, 1).
 * @returns {object} Selected available mission.
 */
export function chooseSurpriseMission(catalog, random = Math.random) {
  const candidates = availableMissions(catalog);
  if (candidates.length === 0) {
    throw new Error("Surprise Me needs at least one available mission.");
  }
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Surprise Me random source must return a value from 0 up to, but not including, 1.");
  }
  return candidates[Math.floor(value * candidates.length)];
}

/**
 * Resolve one catalog mission without ever launching an unavailable entry.
 *
 * @param {ReadonlyArray<object>} catalog - Valid launcher catalog.
 * @param {string} missionId - Stable catalog id.
 * @returns {{ok: true, mission: object, target: string}|{ok: false, mission: object|null, reason: string}}
 */
export function resolveMissionLaunch(catalog, missionId) {
  validateDemoLauncherCatalog(catalog);
  const mission = catalog.find((entry) => entry.id === missionId) || null;
  if (!mission) {
    return { ok: false, mission: null, reason: "Unknown mission." };
  }
  if (mission.availability !== "available") {
    return {
      ok: false,
      mission,
      reason: mission.availabilityReason || "Mission is not available.",
    };
  }
  return { ok: true, mission, target: mission.target };
}

/**
 * Wrap a card-grid focus index for arrow and gamepad movement.
 *
 * @param {number} currentIndex - Current enabled-card index.
 * @param {number} delta - Positive or negative movement.
 * @param {number} itemCount - Number of enabled cards.
 * @returns {number} Wrapped enabled-card index.
 */
export function moveMissionFocus(currentIndex, delta, itemCount) {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(delta) || !Number.isInteger(itemCount)) {
    throw new TypeError("Mission focus movement requires integer inputs.");
  }
  if (itemCount <= 0) return -1;
  return ((currentIndex + delta) % itemCount + itemCount) % itemCount;
}

/**
 * Convert a keyboard key into a deterministic launcher action.
 *
 * @param {string} key - KeyboardEvent key.
 * @param {number} currentIndex - Current enabled-card index.
 * @param {number} itemCount - Number of enabled cards.
 * @returns {{kind: "focus", index: number}|{kind: "confirm"}|{kind: "dismiss"}|{kind: "none"}}
 */
export function launcherKeyAction(key, currentIndex, itemCount) {
  if (["ArrowRight", "ArrowDown"].includes(key)) {
    return { kind: "focus", index: moveMissionFocus(currentIndex, 1, itemCount) };
  }
  if (["ArrowLeft", "ArrowUp"].includes(key)) {
    return { kind: "focus", index: moveMissionFocus(currentIndex, -1, itemCount) };
  }
  if (key === "Home") return { kind: "focus", index: itemCount > 0 ? 0 : -1 };
  if (key === "End") return { kind: "focus", index: itemCount > 0 ? itemCount - 1 : -1 };
  if (key === "Enter" || key === " ") return { kind: "confirm" };
  if (key === "Escape") return { kind: "dismiss" };
  return { kind: "none" };
}

/**
 * Mount the reusable mission launcher into an existing element.
 *
 * @param {HTMLElement} root - Empty or replaceable mount element.
 * @param {object} [options] - Catalog, navigation, storage, and integration hooks.
 * @returns {() => void} Teardown function.
 */
export function mountDemoLauncher(root, options = {}) {
  if (!root || root.nodeType !== 1 || !root.ownerDocument) {
    throw new TypeError("mountDemoLauncher needs a real HTML element.");
  }

  const catalog = options.catalog || createDemoLauncherCatalog({
    airportAvailable: options.airportAvailable === true,
  });
  validateDemoLauncherCatalog(catalog);
  const technologies = options.technologies || DEMO_TECHNOLOGIES;
  validateTechnologyShowcase(technologies);

  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const storage = options.storage || (view ? view.sessionStorage : null);
  const navigate = typeof options.navigate === "function"
    ? options.navigate
    : (target) => view.location.assign(target);

  root.replaceChildren();
  root.classList.add("demo-launcher-root");

  const shell = doc.createElement("main");
  shell.className = "demo-launcher";
  shell.setAttribute("aria-labelledby", "demo-launcher-title");
  const motionPreference = createMotionPreference({ view, target: shell });

  const orbit = doc.createElement("div");
  orbit.className = "demo-launcher-orbit";
  orbit.setAttribute("aria-hidden", "true");
  shell.append(orbit);

  const header = doc.createElement("header");
  header.className = "demo-launcher-header";
  const eyebrow = doc.createElement("p");
  eyebrow.className = "demo-launcher-eyebrow";
  eyebrow.textContent = "Welcome to the";
  const title = doc.createElement("h1");
  title.id = "demo-launcher-title";
  title.textContent = "Open Spatial Lab";
  const intro = doc.createElement("p");
  intro.className = "demo-launcher-intro";
  intro.textContent = "See how portable identity, linked worlds, portal handoffs, spatial content, and browser rendering meet in one interoperability lab.";
  const headerGithubLink = doc.createElement("a");
  headerGithubLink.className = "demo-launcher-github-link";
  headerGithubLink.href = "https://github.com/openspatials/open-spatial-lab";
  headerGithubLink.target = "_blank";
  headerGithubLink.rel = "noopener noreferrer";
  headerGithubLink.setAttribute("aria-label", "Open the Open Spatial Lab GitHub repository");
  const headerGithubLogo = doc.createElement("img");
  headerGithubLogo.className = "demo-launcher-github-logo";
  headerGithubLogo.src = "./assets/icons8-github-250.svg";
  headerGithubLogo.alt = "";
  headerGithubLogo.setAttribute("aria-hidden", "true");
  headerGithubLink.append(headerGithubLogo);
  header.append(eyebrow, title, intro, headerGithubLink);

  if (options.previewMode) {
    const previewNotice = doc.createElement("p");
    previewNotice.className = "demo-launcher-preview-notice";
    previewNotice.textContent = options.simulatedAvailability
      ? "STANDALONE PREVIEW - availability shown here is simulated preview data"
      : "STANDALONE PREVIEW - launcher actions are simulated here";
    header.append(previewNotice);
  }

  // The "From person to place" workflow section was removed in the design reskin.
  // The technology showcase below remains the canonical register;
  // its entries still carry workflowStep metadata for the catalog validator.

  const technologySection = doc.createElement("section");
  technologySection.className = "demo-launcher-technologies";
  technologySection.setAttribute("aria-labelledby", "demo-launcher-technologies-title");
  const technologyHeading = doc.createElement("div");
  technologyHeading.className = "demo-launcher-section-heading";
  const technologyTitle = doc.createElement("h2");
  technologyTitle.id = "demo-launcher-technologies-title";
  technologyTitle.textContent = "Technologies in and around the demo";
  technologyHeading.append(technologyTitle);
  const technologyGrid = doc.createElement("div");
  technologyGrid.className = "demo-launcher-technology-grid";
  for (const technology of technologies) {
    const article = doc.createElement("article");
    article.className = "demo-launcher-technology-card";
    article.dataset.status = technology.statusKey;
    const mark = doc.createElement("span");
    mark.className = "demo-launcher-technology-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = technology.mark;
    const name = doc.createElement("h3");
    const link = doc.createElement("a");
    link.href = technology.officialUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = technology.name;
    const arrow = doc.createElement("span");
    arrow.className = "demo-launcher-outbound-mark";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = " ↗";
    const suffix = doc.createElement("span");
    suffix.className = "demo-launcher-sr-only";
    suffix.textContent = " (opens official site in a new tab)";
    link.append(arrow, suffix);
    name.append(link);
    const status = doc.createElement("span");
    status.className = "demo-launcher-technology-status";
    status.textContent = technology.statusLabel;
    const role = doc.createElement("p");
    role.className = "demo-launcher-technology-role";
    role.textContent = technology.role;
    const claim = doc.createElement("p");
    claim.className = "demo-launcher-technology-claim";
    claim.textContent = technology.claim;
    article.append(mark, name, status, role, claim);
    technologyGrid.append(article);
  }
  const independence = doc.createElement("p");
  independence.className = "demo-launcher-independence-note";
  independence.textContent = "Open Spatial Lab is an independent interoperability prototype. Technology names and marks belong to their respective owners. A listing describes this project's evidenced use, test work, or exploration; it does not imply sponsorship, certification, partnership, conformance, or endorsement.";
  const sourceGithubLink = doc.createElement("a");
  sourceGithubLink.className = "demo-launcher-source-link";
  sourceGithubLink.href = "https://github.com/openspatials/open-spatial-lab";
  sourceGithubLink.target = "_blank";
  sourceGithubLink.rel = "noopener noreferrer";
  sourceGithubLink.textContent = "github.com/openspatials/open-spatial-lab";
  technologySection.append(technologyHeading, technologyGrid, independence, sourceGithubLink);

  const missionSection = doc.createElement("section");
  missionSection.id = "demo-launcher-actions";
  missionSection.className = "demo-launcher-missions";
  missionSection.setAttribute("aria-labelledby", "demo-launcher-missions-title");
  const missionHeading = doc.createElement("div");
  missionHeading.className = "demo-launcher-section-heading";
  const missionTitle = doc.createElement("h2");
  missionTitle.id = "demo-launcher-missions-title";
  missionTitle.textContent = "Ready to explore?";
  missionHeading.append(missionTitle);

  const cardButtons = [];
  const groupSections = new Map();
  for (const [group, titleText, instruction] of [
    ["player", null, null],
    ["destinations", "Destinations", "Open a client destination or a supported direct-start view."],
    ["servers", "Servers", "Open a read-only observer view."],
  ]) {
    const groupSection = doc.createElement("section");
    groupSection.className = `demo-launcher-group demo-launcher-group-${group}`;
    groupSection.dataset.launcherGroup = group;
    const row = doc.createElement("div");
    row.className = "demo-launcher-group-row";
    if (titleText) {
      const heading = doc.createElement("h3");
      heading.className = "demo-launcher-group-title";
      heading.textContent = titleText;
      groupSection.append(heading);
    }
    if (instruction) {
      const copy = doc.createElement("p");
      copy.className = "demo-launcher-group-copy";
      copy.textContent = instruction;
      groupSection.append(copy);
    }
    groupSection.append(row);
    groupSections.set(group, row);
    missionSection.append(groupSection);
  }

  for (const mission of catalog) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `demo-launcher-card accent-${mission.accent}${mission.launcherGroup === "player" ? " demo-launcher-card-primary" : ""}`;
    button.dataset.missionId = mission.id;
    button.dataset.viewKind = mission.viewKind;
    button.dataset.launcherGroup = mission.launcherGroup;
    button.disabled = mission.availability !== "available";

    const cardTop = doc.createElement("span");
    cardTop.className = "demo-launcher-card-top";
    const emblem = doc.createElement("span");
    emblem.className = "demo-launcher-emblem";
    emblem.setAttribute("aria-hidden", "true");
    emblem.textContent = mission.emblem;
    const badge = doc.createElement("span");
    badge.className = "demo-launcher-badge";
    badge.textContent = mission.capabilityBadge;
    cardTop.append(emblem, badge);

    const label = doc.createElement("span");
    label.className = "demo-launcher-card-label";
    label.textContent = mission.label;
    button.append(cardTop, label);
    if (mission.description) {
      const description = doc.createElement("span");
      description.className = "demo-launcher-card-description";
      description.id = `mission-description-${mission.id}`;
      description.textContent = mission.description;
      button.setAttribute("aria-describedby", description.id);
      button.append(description);
    }
    if (mission.launcherGroup === "player") {
      const facts = doc.createElement("span");
      facts.className = "demo-launcher-card-facts";
      for (const [factLabel, factValue] of [
        ["WHO", mission.who],
        ["WHERE", mission.where],
        ["VIEW", mission.reality],
      ]) {
        const fact = doc.createElement("span");
        const strong = doc.createElement("strong");
        strong.textContent = factLabel;
        fact.append(strong, doc.createTextNode(factValue));
        facts.append(fact);
      }
      button.append(facts);
    }
    if (mission.availability !== "available") {
      const reason = doc.createElement("span");
      reason.className = "demo-launcher-unavailable-reason";
      reason.id = `mission-unavailable-${mission.id}`;
      reason.textContent = mission.availabilityReason;
      button.setAttribute(
        "aria-describedby",
        mission.description
          ? `mission-description-${mission.id} mission-unavailable-${mission.id}`
          : `mission-unavailable-${mission.id}`,
      );
      button.append(reason);
    }
    groupSections.get(mission.launcherGroup).append(button);
    cardButtons.push(button);
  }
  missionSection.prepend(missionHeading);

  const liveRegion = doc.createElement("p");
  liveRegion.className = "demo-launcher-live-region";
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.setAttribute("aria-atomic", "true");

  const dock = doc.createElement("div");
  dock.className = "demo-launcher-dock";
  const hostedLink = doc.createElement("a");
  hostedLink.className = "demo-launcher-dock-link demo-launcher-dock-hosted";
  hostedLink.href = "https://labs.peers.social/open-spatial-lab/";
  hostedLink.target = "_blank";
  hostedLink.rel = "noopener noreferrer";
  hostedLink.textContent = "labs.peers.social/open-spatial-lab";
  dock.append(hostedLink);

  shell.append(header, missionSection, technologySection, liveRegion);
  root.append(shell, dock);

  const enabledButtons = cardButtons.filter((button) => !button.disabled);
  let gamepadFrame = null;
  let previousGamepadButtons = new Set();
  let navigationCommitted = false;

  function setLiveText(message) {
    liveRegion.textContent = "";
    view.setTimeout(() => {
      liveRegion.textContent = message;
    }, 0);
  }

  function setStoredMissionId(missionId) {
    try {
      if (storage) storage.setItem(LAST_MISSION_KEY, missionId);
    } catch {
      setLiveText("Session storage is unavailable; this mission will not be remembered.");
    }
  }

  function recordPrimaryRecon(missionId) {
    if (!PRIMARY_MISSION_IDS.includes(missionId)) return;
    try {
      if (!storage) return;
      const previous = JSON.parse(storage.getItem(PRIMARY_RECON_KEY) || "[]");
      const opened = new Set(Array.isArray(previous) ? previous : []);
      opened.add(missionId);
      storage.setItem(PRIMARY_RECON_KEY, JSON.stringify([...opened]));
      if (opened.size === PRIMARY_MISSION_IDS.length) {
        setLiveText("Recon challenge complete: all three primary perspectives opened this session.");
      }
    } catch {
      // The challenge is optional; navigation must remain available without storage.
    }
  }

  function activateMission(missionId) {
    if (navigationCommitted) return;
    const result = resolveMissionLaunch(catalog, missionId);
    if (!result.ok) {
      setLiveText(result.reason);
      return;
    }
    if (result.mission.launchMode === "portal-c-gated") {
      if (typeof options.launchPortalC !== "function") {
        setLiveText("Denver Skyport needs the Phase B Portal C integration hook before it can launch.");
        return;
      }
      navigationCommitted = true;
      setStoredMissionId(missionId);
      options.launchPortalC(result.mission);
      return;
    }
    navigationCommitted = true;
    setStoredMissionId(missionId);
    recordPrimaryRecon(missionId);
    navigate(result.target, result.mission);
  }

  for (const button of cardButtons) {
    button.addEventListener("click", () => activateMission(button.dataset.missionId));
  }

  function handleLauncherKey(event) {
    // The integrated world keeps its keyboard controller mounted while this
    // launcher is visible. Keep launcher events inside this input boundary so
    // hidden player controls cannot cancel native page-scrolling keys.
    event.stopPropagation();
    const currentIndex = enabledButtons.indexOf(doc.activeElement);
    const action = launcherKeyAction(event.key, currentIndex, enabledButtons.length);
    if (action.kind === "focus" && action.index >= 0 && currentIndex >= 0) {
      event.preventDefault();
      enabledButtons[action.index].focus();
    } else if (action.kind === "confirm" && enabledButtons.includes(doc.activeElement)) {
      event.preventDefault();
      doc.activeElement.click();
    } else if (action.kind === "dismiss") {
      event.preventDefault();
      if (typeof options.onDismiss === "function") options.onDismiss();
      else setLiveText("Launcher remains open. Choose a mission when ready.");
    }
  }
  root.addEventListener("keydown", handleLauncherKey);

  const gamepadTick = () => {
    const pads = view.navigator.getGamepads ? [...view.navigator.getGamepads()].filter(Boolean) : [];
    const pad = pads[0];
    const pressed = new Set();
    if (pad) {
      for (const index of [0, 12, 13, 14, 15]) {
        if (pad.buttons[index] && pad.buttons[index].pressed) pressed.add(index);
      }
      const currentIndex = enabledButtons.indexOf(doc.activeElement);
      const newlyPressed = (index) => pressed.has(index) && !previousGamepadButtons.has(index);
      if (newlyPressed(12) || newlyPressed(14)) {
        const start = currentIndex >= 0 ? currentIndex : 0;
        enabledButtons[moveMissionFocus(start, -1, enabledButtons.length)]?.focus();
      } else if (newlyPressed(13) || newlyPressed(15)) {
        const start = currentIndex >= 0 ? currentIndex : -1;
        enabledButtons[moveMissionFocus(start, 1, enabledButtons.length)]?.focus();
      } else if (newlyPressed(0) && enabledButtons.includes(doc.activeElement)) {
        doc.activeElement.click();
      }
    }
    previousGamepadButtons = pressed;
    gamepadFrame = view.requestAnimationFrame(gamepadTick);
  };

  if (enabledButtons.length > 0 && options.initialFocus === true) {
    enabledButtons[0].focus({ preventScroll: true });
  }
  if (view && view.navigator && view.requestAnimationFrame) {
    gamepadFrame = view.requestAnimationFrame(gamepadTick);
  }

  return function teardownDemoLauncher() {
    root.removeEventListener("keydown", handleLauncherKey);
    if (gamepadFrame !== null && view) view.cancelAnimationFrame(gamepadFrame);
    motionPreference.dispose();
    root.replaceChildren();
    root.classList.remove("demo-launcher-root");
  };
}
