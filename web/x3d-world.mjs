// Loads an X3D JSON world, with an X3D Anchor as its portal, under X3DOM or X_ITE. This answers John
// Carlson's finding on a portal shape for his Ex3D JSON format: an Anchor whose url is the
// destination world's address, plus a ProximitySensor as the walk-in trigger.
//
// The world file stays free of any renderer. This page adds ?renderer= to the Anchor's url, so the
// crossing lands in Location B under the same engine.
import { rendererKindFromSearch } from "./vendor/scene-core/render-adapter/render-adapter.mjs";
import { SOFT_BODY_WORLD_FILE, loadAmmo, prepareWorld, runWorld } from "./soft-body-world.mjs";

const WORLDS_ROOT = "./x3d-worlds/";
const DEFAULT_WORLD = "anchor-portal-world.x3d.json";
const WALK_SPEED_M_PER_S = 2.4;

const params = new URLSearchParams(location.search);
// X3D opens only behind ?renderer=: with no X3D engine named, this page says so and draws nothing.
const requestedKind = rendererKindFromSearch(location.search);
const kind = requestedKind === "x3dom" || requestedKind === "x_ite" ? requestedKind : null;
const worldFile = /^[A-Za-z0-9._-]+\.json$/.test(params.get("world") || "") ? params.get("world") : DEFAULT_WORLD;
const softBody = worldFile === SOFT_BODY_WORLD_FILE;
const worldUrl = new URL(`${WORLDS_ROOT}${worldFile}`, location.href).href;

const state = { kind, worldFile, loaded: false, anchorUrl: null, parameter: null, crossingVia: null, cameraPosition: null };
window.__x3dWorld = state;
document.body.dataset.x3dWorldRenderer = kind || "";

function destinationUrl(url) {
  const target = new URL(url, location.href);
  target.searchParams.set("renderer", kind);
  target.searchParams.set("role", "player");
  target.searchParams.set("intro", "bypass");
  return `${target.pathname}${target.search}`;
}

function findNode(value, type) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findNode(item, type);
      if (hit) return hit;
    }
    return null;
  }
  if (value[type]) return value[type];
  for (const child of Object.values(value)) {
    const hit = findNode(child, type);
    if (hit) return hit;
  }
  return null;
}

function hud({ title, engine, url }) {
  document.getElementById("hud-title").textContent = title;
  document.getElementById("hud-engine").textContent = engine;
  document.getElementById("hud-url").textContent = url;
}

// W, A, S and D move the viewpoint on the floor, in both engines.
// In John Carlson's world A is his arm key, so the left arrow walks left there, and the walk follows the view.
function walkControls(applyPosition, { yaw = 0, leftKey = "KeyA" } = {}) {
  const keys = new Set();
  window.addEventListener("keydown", (event) => keys.add(event.code));
  window.addEventListener("keyup", (event) => keys.delete(event.code));
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const side = (keys.has("KeyD") ? 1 : 0) - (keys.has(leftKey) ? 1 : 0);
    const ahead = (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0);
    if (side || ahead) {
      const dx = side * Math.cos(yaw) + ahead * Math.sin(yaw);
      const dz = -side * Math.sin(yaw) + ahead * Math.cos(yaw);
      const p = state.cameraPosition;
      state.cameraPosition = [p[0] + dx * WALK_SPEED_M_PER_S * dt, p[1], p[2] + dz * WALK_SPEED_M_PER_S * dt];
      applyPosition(state.cameraPosition);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Where the Entry viewpoint stands and which way it turns, from the world data.
function entryOf(json) {
  const entry = findNode(json.X3D.Scene, "Viewpoint");
  return { position: [...entry["@position"]], yaw: (entry["@orientation"]?.[1] ?? 0) * (entry["@orientation"]?.[3] ?? 0) };
}

async function fetchWorld() {
  const response = await fetch(worldUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`the world file answered ${response.status}`);
  return response.json();
}

function softBodyHud() {
  document.getElementById("hud-how").innerHTML = "W, S, D and the left arrow walk. Q and A swing the arm. Click the orange disc, or walk into it, to go back. Its X3D Anchor goes to <code id=\"hud-url\">...</code>";
  const credit = document.createElement("p");
  credit.id = "hud-credit";
  credit.textContent = "World and physics by John Carlson (coderextreme/open-spatial-lab, commit bf12953173, Apache-2.0). His humanoid is left out here; the renderer page says why.";
  document.getElementById("hud-how").after(credit);
}

function crossBy(via, navigate) {
  if (state.crossingVia) return;
  state.crossingVia = via;
  document.body.dataset.x3dWorldCrossing = via;
  navigate();
}

async function startXIte() {
  const { default: X3D } = await import("./vendor/scene-core/vendor/x_ite/x_ite.min.mjs");
  const canvas = X3D.createBrowser();
  canvas.setAttribute("splashScreen", "false");
  canvas.setAttribute("notifications", "false");
  canvas.setAttribute("contextMenu", "false");
  canvas.setAttribute("timings", "false");
  document.getElementById("world-host").appendChild(canvas);
  const browser = canvas.browser;
  let entry = { position: [0, 1.6, 6], yaw: 0 };
  let prepared = null;
  if (softBody) {
    const json = await fetchWorld();
    entry = entryOf(json);
    prepared = prepareWorld(json);
    await browser.loadComponents(browser.getComponent("RigidBodyPhysics"));
    await browser.replaceWorld(await browser.createX3DFromString(JSON.stringify(prepared.json)));
  } else {
    await browser.loadURL(new X3D.MFString(worldUrl));
  }
  const scene = browser.currentScene;
  const anchor = scene.getNamedNode("PortalAnchor");
  if (!anchor) throw new Error("the world has no X3D Anchor named PortalAnchor");
  const url = destinationUrl(anchor.url[0]);
  anchor.url = new X3D.MFString(url);
  state.anchorUrl = url;
  state.parameter = anchor.parameter[0] || "";
  state.cameraPosition = entry.position;

  const viewpoint = scene.getNamedNode("Entry");
  walkControls((position) => { viewpoint.position = new X3D.SFVec3f(position[0], position[1], position[2]); }, softBody ? { yaw: entry.yaw, leftKey: "ArrowLeft" } : {});
  if (prepared) {
    const ammo = await loadAmmo();
    const pointsOf = (def) => scene.getNamedNode(`Soft_${def}`);
    const flatToPoints = (flat) => {
      const values = [];
      for (let i = 0; i < flat.length; i += 3) values.push(new X3D.SFVec3f(flat[i], flat[i + 1], flat[i + 2]));
      return new X3D.MFVec3f(...values);
    };
    state.physics = runWorld(ammo, prepared, {
      setPose(def, t, r) {
        const node = scene.getNamedNode(`Body_${def}`);
        node.translation = new X3D.SFVec3f(t[0], t[1], t[2]);
        node.rotation = new X3D.SFRotation(r[0], r[1], r[2], r[3]);
      },
      setPoints(def, flat) { pointsOf(def).point = flatToPoints(flat); },
      readPoints(def) { return Array.from(pointsOf(def).point, (p) => [p.x, p.y, p.z]); },
    });
  }
  const trigger = scene.getNamedNode("PortalTrigger");
  trigger.addFieldCallback("portal-crossing", "isActive", (active) => {
    if (active) crossBy("proximity-sensor", () => browser.loadURL(anchor.url, anchor.parameter));
  });
  return { engine: "X_ITE 16.6.0", title: scene.getMetaData?.("title")?.[0] || "Anchor portal test world", url };
}

async function startX3dom() {
  const host = document.getElementById("x3dom-world");
  document.getElementById("world-host").appendChild(host);
  const json = await fetchWorld();
  const anchorJson = findNode(json.X3D.Scene, "Anchor");
  if (!anchorJson) throw new Error("the world has no X3D Anchor");
  const entry = softBody ? entryOf(json) : { position: [0, 1.6, 6], yaw: 0 };
  const prepared = softBody ? prepareWorld(json) : null;
  const parsed = new window.x3dom.JSONParser().parseJavaScript(prepared ? prepared.json : json);
  const parsedScene = parsed.getElementsByTagName("Scene")[0] || parsed.getElementsByTagName("scene")[0];
  if (!parsedScene) throw new Error("X3DOM's JSON parser returned no Scene");
  const sceneEl = document.getElementById("x3dom-world-scene");
  for (const child of Array.from(parsedScene.children)) sceneEl.appendChild(document.importNode(child, true));
  const anchorEl = sceneEl.querySelector("anchor");
  const url = destinationUrl(anchorEl.getAttribute("url").replace(/["']/g, "").trim().split(/\s+/)[0]);
  anchorEl.setAttribute("url", `"${url}"`);
  state.anchorUrl = url;
  state.parameter = anchorJson["@parameter"]?.[0] || "";
  state.cameraPosition = entry.position;
  const viewpoint = sceneEl.querySelector("viewpoint");
  // X3DOM has no ProximitySensor node. The page reads the sensor's box from the JSON and tests it.
  const sensor = findNode(json.X3D.Scene, "ProximitySensor");
  const center = sensor?.["@center"] || [0, 0, 0];
  const size = sensor?.["@size"] || [0, 0, 0];
  walkControls((position) => {
    viewpoint.setAttribute("position", position.join(" "));
    const inside = position.every((value, axis) => Math.abs(value - center[axis]) <= size[axis] / 2);
    if (inside) crossBy("proximity-box", () => window.open(url, "_self"));
  }, softBody ? { yaw: entry.yaw, leftKey: "ArrowLeft" } : {});
  if (prepared) {
    const byDef = new Map();
    for (const element of sceneEl.querySelectorAll("*")) {
      const def = element.getAttribute("DEF") || element.getAttribute("def");
      if (def) byDef.set(def, element);
    }
    state.physics = runWorld(await loadAmmo(), prepared, {
      setPose(def, t, r) {
        const node = byDef.get(`Body_${def}`);
        node.setAttribute("translation", t.join(" "));
        node.setAttribute("rotation", r.join(" "));
      },
      setPoints(def, flat) { byDef.get(`Soft_${def}`).setAttribute("point", flat.join(" ")); },
      readPoints(def) {
        const numbers = byDef.get(`Soft_${def}`).getAttribute("point").trim().split(/[\s,]+/).map(Number);
        const out = [];
        for (let i = 0; i + 2 < numbers.length; i += 3) out.push([numbers[i], numbers[i + 1], numbers[i + 2]]);
        return out;
      },
    });
  }
  return { engine: "X3DOM 1.8.3", title: json.X3D.head.meta.find((m) => m["@name"] === "title")?.["@content"] || worldFile, url };
}

try {
  if (!kind) throw new Error("Add ?renderer=x_ite or ?renderer=x3dom to the address to open this world.");
  if (softBody) softBodyHud();
  const result = kind === "x3dom" ? await startX3dom() : await startXIte();
  hud(result);
  state.loaded = true;
  document.body.dataset.x3dWorldReady = "1";
} catch (error) {
  state.error = (error && error.message) || String(error);
  document.body.dataset.x3dWorldError = state.error;
  hud({ title: "The X3D JSON world did not load", engine: state.error, url: "..." });
  console.error("[x3d-world]", error);
}
