// web/wow-dashboard.mjs — the data-point dashboard (iteration 3).
//
// Usage: wow-dashboard.html?point=<data-point URL>&point=<data-point URL>
// Each point shows its value, its source world (the World resource's label and base URL), the revision
// of the change that set it, and its age, computed from that change's `time`.

import { createObserver } from "./wow-observe.mjs";

const params = new URLSearchParams(location.search);
const urls = params.getAll("point");
const list = document.getElementById("points");
const cards = new Map();
const worlds = new Map();

function format(value) {
  if (value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return JSON.stringify(value);
}

function age(time) {
  if (!time) return "—";
  const seconds = Math.max(0, (Date.now() - Date.parse(time)) / 1000);
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

async function worldLabel(base) {
  if (!worlds.has(base)) {
    worlds.set(base, fetch(new URL("wow/world", base), { headers: { Accept: "application/wow+json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => (w && w.content && w.content.label) || base)
      .catch(() => base));
  }
  return worlds.get(base);
}

function card(url) {
  if (cards.has(url)) return cards.get(url);
  const el = document.createElement("article");
  el.className = "point";
  el.innerHTML = '<div class="world">…</div><div class="url"></div><div class="value">—</div>'
    + '<div class="meta"><span>revision <b class="revision">—</b></span><span>age <b class="age">—</b></span><span>status <b class="status">pending</b></span></div>';
  el.querySelector(".url").textContent = url;
  list.appendChild(el);
  cards.set(url, el);
  return el;
}

function render(point) {
  const el = card(point.url);
  el.className = `point ${point.status === "ok" ? "" : point.status.replace(/\s+/g, "-")}`;
  el.querySelector(".value").textContent = format(point.value);
  el.querySelector(".revision").textContent = point.revision === null || point.revision === undefined ? "—" : String(point.revision);
  el.querySelector(".status").textContent = point.status;
  el.dataset.time = point.time || "";
  el.dataset.revision = point.revision === null || point.revision === undefined ? "" : String(point.revision);
  el.dataset.value = JSON.stringify(point.value === undefined ? null : point.value);
  worldLabel(point.base).then((label) => {
    el.querySelector(".world").textContent = `${label} · ${point.base}`;
    el.dataset.world = label;
  });
}

const observer = createObserver({ onChange: render });
for (const url of urls) {
  card(url);
  observer.watch(url).then(render).catch((error) => {
    const el = card(url);
    el.querySelector(".status").textContent = `error: ${error.message}`;
  });
}

setInterval(() => {
  for (const el of cards.values()) el.querySelector(".age").textContent = age(el.dataset.time);
}, 250);

window.__wowDashboard = { observer, urls };
document.body.dataset.dashboardReady = "1";
