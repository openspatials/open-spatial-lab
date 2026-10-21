const SERVICE_PORTS = Object.freeze([18151, 18152, 18153]);

export const PRIMARY_MISSION_IDS = Object.freeze([
  "player-lobby",
  "server-a-observer",
  "server-b-observer",
]);

const ALLOWED_VIEW_KINDS = Object.freeze([
  "player",
  "observer",
  "destination",
]);

const ALLOWED_AVAILABILITY = Object.freeze(["available", "unavailable"]);
const ALLOWED_LAUNCHER_GROUPS = Object.freeze(["player", "servers", "destinations"]);

const OFFICIAL_TECHNOLOGY_URLS = Object.freeze({
  "universal-manifest": "https://universalmanifest.net/",
  "web-of-worlds": "https://webofworlds.github.io/",
  "oma3-iwps": "https://github.com/oma3dao/iwps-specification",
  "rp1-spatial-fabric": "https://rp1.com/",
  gltf: "https://registry.khronos.org/glTF/",
  vrm: "https://vrm.dev/en/vrm/",
  "three-js": "https://threejs.org/",
  geopose: "https://docs.ogc.org/is/21-056r11/21-056r11.html",
  "msf-ombi": "https://metaverse-standards.org/",
  c2pa: "https://c2pa.org/",
});

const TECHNOLOGY_ITEMS = [
  {
    id: "universal-manifest",
    name: "Universal Manifest",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS["universal-manifest"],
    workflowStep: 1,
    role: "Carry signed portable context between worlds and services.",
    statusKey: "verified-scope",
    statusLabel: "Verified v0.1 scope",
    claim: "Passes the UM runner's v0.1 baseline matrix; broader conformance is not claimed.",
    mark: "UM",
  },
  {
    id: "web-of-worlds",
    name: "Web of Worlds / OpenSpatialWorld",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS["web-of-worlds"],
    workflowStep: 2,
    role: "Describe linked worlds as composition graphs and API-shaped resources.",
    statusKey: "integrated-prototype",
    statusLabel: "Integrated prototype",
    claim: "Implemented and shape-validated here; no Web of Worlds conformance claim.",
    mark: "WoW",
  },
  {
    id: "oma3-iwps",
    name: "OMA3 IWPS",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS["oma3-iwps"],
    workflowStep: 3,
    role: "Frame the query-to-teleport conversation needed to cross between worlds.",
    statusKey: "iwps-shaped",
    statusLabel: "IWPS-shaped mapping",
    claim: "A spec-cited mapping; IWPS parameters are not on the wire and conformance is not claimed.",
    mark: "IWPS",
  },
  {
    id: "rp1-spatial-fabric",
    name: "RP1 Spatial Fabric / .msf",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS["rp1-spatial-fabric"],
    workflowStep: 4,
    role: "Address, sign, load, and compose spatial worlds as fabric resources.",
    statusKey: "integrated-prototype",
    statusLabel: "Integrated prototype",
    claim: "Bounded signed-.msf composition in the lab, not the canonical full renderer.",
    mark: "RP1",
  },
  {
    id: "gltf",
    name: "glTF",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS.gltf,
    workflowStep: 4,
    role: "Package portable 3D scenes, meshes, materials, and animation.",
    statusKey: "powers-demo",
    statusLabel: "Powers this demo",
    claim: "Portable 3D scenes and animation used by the current content pipeline.",
    mark: "glTF",
  },
  {
    id: "vrm",
    name: "VRM",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS.vrm,
    workflowStep: 4,
    role: "Carry humanoid avatar identity, rigging, expressions, and motion on top of glTF.",
    statusKey: "powers-demo",
    statusLabel: "Powers this demo",
    claim: "Portable humanoid avatars, expressions, and movement layered on glTF.",
    mark: "VRM",
  },
  {
    id: "three-js",
    name: "Three.js",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS["three-js"],
    workflowStep: 5,
    role: "Render and animate the browser-based embodied experience.",
    statusKey: "powers-demo",
    statusLabel: "Powers this demo",
    claim: "The browser runtime for the current embodied lab experience.",
    mark: "three.js",
  },
  {
    id: "geopose",
    name: "OGC GeoPose 1.0",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS.geopose,
    workflowStep: 5,
    role: "Express position and orientation in a standard data shape.",
    statusKey: "schema-subset",
    statusLabel: "Schema-validated subset",
    claim: "Schema-valid Basic pose data in a local frame; not georeferenced or fully conformant.",
    mark: "GeoPose",
  },
  {
    id: "msf-ombi",
    name: "Metaverse Standards Forum / OMBI",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS["msf-ombi"],
    workflowStep: "context",
    role: "Provide upstream coordination context for open browser and spatial-fabric work.",
    statusKey: "ecosystem-context",
    statusLabel: "Ecosystem context",
    claim: "Relevant upstream context, not a runtime dependency or endorsement.",
    mark: "MSF / OMBI",
  },
  {
    id: "c2pa",
    name: "C2PA",
    officialUrl: OFFICIAL_TECHNOLOGY_URLS.c2pa,
    workflowStep: "context",
    role: "Explore future verifiable provenance for spatial assets and handoff content.",
    statusKey: "interoperability-target",
    statusLabel: "Interoperability target",
    claim: "This demo does not currently attach or verify C2PA Content Credentials.",
    mark: "C2PA",
  },
];

/**
 * Validate the public technology register before rendering it.
 *
 * @param {ReadonlyArray<object>} technologies - Candidate technology entries.
 * @returns {ReadonlyArray<object>} The same entries when valid.
 */
export function validateTechnologyShowcase(technologies) {
  if (!Array.isArray(technologies) || technologies.length !== 10) {
    throw new TypeError("Technology showcase must contain the ten accepted entries.");
  }
  const ids = new Set();
  for (const technology of technologies) {
    for (const key of ["id", "name", "officialUrl", "role", "statusKey", "statusLabel", "claim", "mark"]) {
      if (typeof technology?.[key] !== "string" || technology[key].trim() === "") {
        throw new TypeError(`Technology ${technology?.id || "<unknown>"} needs a non-empty ${key}.`);
      }
    }
    if (ids.has(technology.id)) throw new Error(`Duplicate technology id: ${technology.id}`);
    ids.add(technology.id);
    if (technology.officialUrl !== OFFICIAL_TECHNOLOGY_URLS[technology.id]) {
      throw new Error(`Technology ${technology.id} must use its approved official URL.`);
    }
    if (![1, 2, 3, 4, 5, "context"].includes(technology.workflowStep)) {
      throw new Error(`Technology ${technology.id} has an unsupported workflow step.`);
    }
  }
  return technologies;
}

export const DEMO_TECHNOLOGIES = Object.freeze(TECHNOLOGY_ITEMS.map((technology) => Object.freeze({
  ...technology,
  outbound: "new-tab",
})));

validateTechnologyShowcase(DEMO_TECHNOLOGIES);

/**
 * Validate the declarative mission catalog before it reaches the launcher UI.
 *
 * @param {ReadonlyArray<object>} catalog - Candidate mission entries.
 * @returns {ReadonlyArray<object>} The same catalog when valid.
 * @throws {TypeError|Error} When an entry is malformed, duplicated, or dishonest.
 */
export function validateDemoLauncherCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new TypeError("Demo launcher catalog must be a non-empty array.");
  }

  const ids = new Set();
  for (const mission of catalog) {
    if (!mission || typeof mission !== "object") {
      throw new TypeError("Every demo launcher entry must be an object.");
    }

    for (const key of [
      "id",
      "label",
      "viewKind",
      "launcherGroup",
      "target",
      "availability",
      "capabilityBadge",
      "who",
      "where",
      "reality",
    ]) {
      if (typeof mission[key] !== "string" || mission[key].trim() === "") {
        throw new TypeError(`Mission ${mission.id || "<unknown>"} needs a non-empty ${key}.`);
      }
    }
    if (
      Object.hasOwn(mission, "description")
      && (typeof mission.description !== "string" || mission.description.trim() === "")
    ) {
      throw new TypeError(`Mission ${mission.id || "<unknown>"} description must be non-empty when present.`);
    }

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mission.id)) {
      throw new Error(`Mission id is not stable-kebab-case: ${mission.id}`);
    }
    if (ids.has(mission.id)) {
      throw new Error(`Duplicate mission id: ${mission.id}`);
    }
    ids.add(mission.id);

    if (!ALLOWED_VIEW_KINDS.includes(mission.viewKind)) {
      throw new Error(`Mission ${mission.id} has unsupported view kind: ${mission.viewKind}`);
    }
    if (!ALLOWED_LAUNCHER_GROUPS.includes(mission.launcherGroup)) {
      throw new Error(`Mission ${mission.id} has unsupported launcher group: ${mission.launcherGroup}`);
    }
    if (!ALLOWED_AVAILABILITY.includes(mission.availability)) {
      throw new Error(`Mission ${mission.id} has unsupported availability: ${mission.availability}`);
    }

    if (
      /^[a-z][a-z0-9+.-]*:/i.test(mission.target)
      || mission.target.startsWith("//")
      || SERVICE_PORTS.some((port) => mission.target.includes(String(port)))
    ) {
      throw new Error(`Mission ${mission.id} target must be a same-origin browser route, not a service URL.`);
    }

    const resolvedTarget = new URL(mission.target, "http://osl.invalid/");
    if (resolvedTarget.origin !== "http://osl.invalid") {
      throw new Error(`Mission ${mission.id} target escapes the browser origin.`);
    }

    if (mission.availability === "unavailable") {
      if (typeof mission.availabilityReason !== "string" || mission.availabilityReason.trim() === "") {
        throw new Error(`Unavailable mission ${mission.id} needs an availability reason.`);
      }
      if (/\blive\b/i.test(mission.capabilityBadge)) {
        throw new Error(`Unavailable mission ${mission.id} cannot carry a LIVE badge.`);
      }
    }

    if (mission.backingNode !== null) {
      if (!mission.backingNode || typeof mission.backingNode !== "object") {
        throw new TypeError(`Mission ${mission.id} backingNode must be metadata or null.`);
      }
      if (!SERVICE_PORTS.includes(mission.backingNode.port)) {
        throw new Error(`Mission ${mission.id} has an unknown local service port.`);
      }
      if (
        typeof mission.backingNode.label !== "string"
        || typeof mission.backingNode.serviceRole !== "string"
      ) {
        throw new TypeError(`Mission ${mission.id} backing node metadata is incomplete.`);
      }
    }

    if (mission.id === "denver-skyport") {
      const airportClaims = [
        mission.description,
        mission.capabilityBadge,
        mission.who,
        mission.where,
        mission.reality,
      ].join(" ");
      if (mission.viewKind !== "destination" || mission.backingNode !== null) {
        throw new Error("Denver Skyport must remain a client-side destination, not a server view.");
      }
      if (/third server|airport server|server-backed|seamless backend|seamless teleport/i.test(airportClaims)) {
        throw new Error("Denver Skyport copy overclaims its client-side scene-load path.");
      }
    }
  }

  const expectedGroups = new Map([
    ["player-lobby", "player"],
    ["server-a-observer", "servers"],
    ["server-b-observer", "servers"],
    ["denver-skyport", "destinations"],
    ["player-location-a", "destinations"],
    ["player-location-b", "destinations"],
  ]);
  for (const [id, group] of expectedGroups) {
    if (catalog.find((mission) => mission.id === id)?.launcherGroup !== group) {
      throw new Error(`Mission ${id} must stay in the explicit ${group} launcher group.`);
    }
  }

  for (const id of PRIMARY_MISSION_IDS) {
    if (!ids.has(id)) {
      throw new Error(`Catalog is missing required primary mission: ${id}`);
    }
  }

  return catalog;
}

/**
 * Build the one source of truth for launcher entries.
 *
 * Denver Skyport is unavailable by default. Phase B may pass
 * `airportAvailable: true` only has terminal proof and the real
 * Portal C integration seam has been re-read.
 *
 * @param {{airportAvailable?: boolean}} [options] - Evidence-backed runtime flags.
 * @returns {ReadonlyArray<object>} Frozen mission entries.
 */
export function createDemoLauncherCatalog(options = {}) {
  const airportAvailable = options.airportAvailable === true;
  const catalog = [
    {
      id: "player-lobby",
      label: "Enter as Player",
      viewKind: "player",
      launcherGroup: "player",
      target: "index.html?role=player",
      backingNode: { label: "Lobby node", serviceRole: "player assignment lobby", port: 18153 },
      availability: "available",
      capabilityBadge: "LOBBY NODE",
      who: "An embodied player",
      where: "The player lobby",
      reality: "App view backed by the lobby node",
      emblem: "P",
      accent: "lobby",
      primary: true,
      launchMode: "browser-route",
    },
    {
      id: "server-a-observer",
      label: "Observe Server A",
      description: "Watch Location A as an observer without becoming its player avatar.",
      viewKind: "observer",
      launcherGroup: "servers",
      target: "index.html?role=source",
      backingNode: { label: "Location A", serviceRole: "world server", port: 18151 },
      availability: "available",
      capabilityBadge: "SERVER VIEW",
      who: "A read-only observer",
      where: "Location A",
      reality: "Browser observer view backed by server A",
      emblem: "A",
      accent: "server-a",
      primary: true,
      launchMode: "browser-route",
    },
    {
      id: "server-b-observer",
      label: "Observe Server B",
      description: "Watch Location B and its amber arrival side as an observer.",
      viewKind: "observer",
      launcherGroup: "servers",
      target: "index.html?role=target",
      backingNode: { label: "Location B", serviceRole: "world server", port: 18152 },
      availability: "available",
      capabilityBadge: "SERVER VIEW",
      who: "A read-only observer",
      where: "Location B",
      reality: "Browser observer view backed by server B",
      emblem: "B",
      accent: "server-b",
      primary: true,
      launchMode: "browser-route",
    },
    {
      id: "denver-skyport",
      label: "Denver Skyport",
      description: "A client-side airport destination entered through the real lobby and Portal C path.",
      viewKind: "destination",
      launcherGroup: "destinations",
      target: "index.html?role=player",
      backingNode: null,
      availability: airportAvailable ? "available" : "unavailable",
      availabilityReason: airportAvailable
        ? "Available through the lobby Portal C route."
        : "The airport route is unavailable.",
      capabilityBadge: airportAvailable ? "DESTINATION" : "PORTAL C PENDING",
      who: "An embodied player",
      where: "A client-loaded destination beyond the lobby",
      reality: "Player view entered through the lobby Portal C path",
      emblem: "D",
      accent: "airport",
      primary: true,
      launchMode: "portal-c-gated",
    },
    {
      id: "player-location-a",
      label: "Start in Location A",
      description: "Skip lobby assignment and begin embodied on the source side.",
      viewKind: "player",
      launcherGroup: "destinations",
      target: "index.html?role=player&active=source",
      backingNode: { label: "Location A", serviceRole: "world server", port: 18151 },
      availability: "available",
      capabilityBadge: "PLAYER",
      who: "An embodied player",
      where: "Location A",
      reality: "Canonical player deep link to the source world",
      emblem: "1",
      accent: "server-a",
      primary: false,
      launchMode: "browser-route",
    },
    {
      id: "player-location-b",
      label: "Start in Location B",
      description: "Skip lobby assignment and begin embodied on the target side.",
      viewKind: "player",
      launcherGroup: "destinations",
      target: "index.html?role=player&active=target",
      backingNode: { label: "Location B", serviceRole: "world server", port: 18152 },
      availability: "available",
      capabilityBadge: "PLAYER",
      who: "An embodied player",
      where: "Location B",
      reality: "Canonical player deep link to the target world",
      emblem: "2",
      accent: "server-b",
      primary: false,
      launchMode: "browser-route",
    },
  ].map((mission) => Object.freeze({
    ...mission,
    backingNode: mission.backingNode ? Object.freeze({ ...mission.backingNode }) : null,
  }));

  validateDemoLauncherCatalog(catalog);
  return Object.freeze(catalog);
}

export const DEMO_LAUNCHER_DEFAULT_CATALOG = createDemoLauncherCatalog();
