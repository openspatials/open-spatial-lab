// web/live-data-page.mjs — the page for roadmap A2's two layers on one place.
//
// Usage: live-data-layers.html?weather=<data-point URL>&game=<data-point URL>
// Each layer's value is followed through its own world's event stream (web/wow-observe.mjs). The pond's
// state comes from the GAME layer's value, which its world mirrors from the weather layer; the page never
// reads the weather value to drive the pond.

import { createObserver } from "./wow-observe.mjs";
import { reaction, ageOf, isStale, formatAge } from "./live-data-layers.mjs";

const params = new URLSearchParams(location.search);
const urls = { weather: params.get("weather"), game: params.get("game") };
const descriptions = { weather: null, game: null };
const history = [];
const ICE = "#e8f6ff";
const WATER = "#2f7fd8";

function format(value) {
  if (value === undefined || value === null) return "—";
  return typeof value === "number" ? `${value.toFixed(2)} °C` : JSON.stringify(value);
}

async function describe(layer) {
  const resource = urls[layer].split("#")[0];
  const r = await fetch(resource, { headers: { Accept: "application/wow+json" }, cache: "no-store" });
  const node = r.ok ? await r.json() : null;
  const props = (node && node.properties) || {};
  const description = Object.assign({}, props);
  delete description.temperature;
  descriptions[layer] = description;
  const el = document.getElementById(layer);
  el.querySelector(".desc").textContent = `${props["@type"] || "?"} · ${resource}`;
  if (layer === "game") document.getElementById("pond-rule").textContent = `freezes below ${props["osl:threshold"]} °C`;
  if (props["osl:place"]) document.getElementById("place").textContent = props["osl:place"];
  return description;
}

let last;
function react(point) {
  const game = descriptions.game;
  const value = point.value;
  const state = game ? reaction(game, value) : "unknown";
  last = value;
  const el = document.getElementById("pond-state");
  el.textContent = state;
  el.dataset.state = state;
  document.getElementById("pond-surface").setAttribute("fill", state === game?.["osl:below"] ? ICE : WATER);
  document.getElementById("pond-cracks").setAttribute("visibility", state === game?.["osl:below"] ? "visible" : "hidden");
  return state;
}

function render(layer, point) {
  const el = document.getElementById(layer);
  el.querySelector(".value").textContent = format(point.value);
  el.querySelector(".revision").textContent = point.revision === null || point.revision === undefined ? "—" : String(point.revision);
  el.querySelector(".status").textContent = point.status;
  el.dataset.time = point.time || "";
  el.dataset.received = new Date().toISOString();
  el.dataset.revision = point.revision === null || point.revision === undefined ? "" : String(point.revision);
  el.dataset.value = JSON.stringify(point.value === undefined ? null : point.value);
  el.dataset.status = point.status;
  const entry = { layer, revision: point.revision, value: point.value, time: point.time, at: Date.now() };
  if (layer === "game") entry.state = react(point);
  history.push(entry);
  tick();
}

function tick() {
  const now = Date.now();
  for (const layer of ["weather", "game"]) {
    const el = document.getElementById(layer);
    const description = descriptions[layer];
    const limit = description ? description["osl:staleAfterSeconds"] : Infinity;
    const age = ageOf(el.dataset.time, now);
    const stale = isStale(el.dataset.time, limit, now);
    el.querySelector(".age").textContent = formatAge(age);
    el.dataset.age = age === null ? "" : age.toFixed(2);
    el.dataset.stale = stale ? "1" : "0";
    el.classList.toggle("stale", stale);
  }
}

const layerOf = new Map(Object.entries(urls).map(([layer, url]) => [url, layer]));
const observer = createObserver({ onChange: (point) => { if (layerOf.has(point.url)) render(layerOf.get(point.url), point); } });

async function start() {
  await Promise.all([describe("weather"), describe("game")]);
  for (const [layer, url] of Object.entries(urls)) {
    document.getElementById(layer).querySelector(".url").title = url;
    observer.watch(url).then((point) => render(layer, point)).catch((error) => {
      document.getElementById(layer).querySelector(".status").textContent = `error: ${error.message}`;
    });
  }
  document.body.dataset.ready = "1";
}

setInterval(tick, 250);
window.__liveData = { observer, history, descriptions, urls };
start();
