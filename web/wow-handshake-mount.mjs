/*
 * The identity handshake in the `?wow=` player (iteration 5, stage A). Browser only.
 *
 * When the shown world states a handshake in its World resource, the visitor's agent (web/wow-handshake.mjs)
 * enters it with the lab visitor's claims, and this page then shows the visitor as the world accepted them:
 * the avatar and the preferred height read back from the User the world made, not from the page's own copy.
 * A short panel shows what the world asked for, what was sent, and the outcome as the world recorded it.
 * A world that states no handshake is shown as before.
 *
 * The page states its pilot (User.pilot) as "agent" when the browser is driven by automation (navigator.webdriver)
 * and "human" otherwise. The panel shows the User the world made by its label (userLabel): a user whose pilot is
 * hybrid is shown as an agent. This panel is where the page shows the User the world made.
 */

import { enterWorld, baseOf, LAB_WALLET, userLabel } from "./wow-handshake.mjs";

/** The page's pilot statement: "agent" when automation drives the browser, "human" otherwise. */
export function pagePilot() {
  return globalThis.navigator && globalThis.navigator.webdriver === true ? "agent" : "human";
}

/** The lab visitor, with the avatar's address made absolute on this page's origin. */
export function labWallet(pageUrl) {
  const claims = { ...LAB_WALLET.claims };
  claims.avatar = { ...claims.avatar, uri: new URL(claims.avatar.uri, pageUrl).href };
  return { claims, pilot: pagePilot() };
}

const label = (name) => name.replace(/_/g, " ");

/**
 * Run the handshake with the world at `hostUrl`. Returns null when the world states no handshake, or
 * { result, user, record } (user and record are what the world serves after the join).
 */
export async function runHandshake({ hostUrl, pageUrl, fetch: f, withhold = [] }) {
  const base = baseOf(hostUrl);
  const probe = await f(new URL("wow/world", base).href, { headers: { Accept: "application/wow+json, application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!probe || !Array.isArray(probe.claims)) return null;
  const result = await enterWorld(base, { wallet: labWallet(pageUrl), withhold, fetch: f });
  let user = null;
  let record = null;
  if (result.answer && result.answer.user) user = await f(new URL(result.answer.user, base).href, { headers: { Accept: "application/wow+json, application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (result.answer && result.answer.record) record = await f(new URL(result.answer.record, base).href).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return { result, user, record };
}

/** The avatar variant whose model is at `uri` (by path), or null. */
export function variantForUri(uri, variants, pageUrl) {
  if (!uri) return null;
  let path;
  try { path = new URL(uri, pageUrl).pathname; } catch { return null; }
  for (const [key, v] of Object.entries(variants)) {
    try { if (v.url && new URL(v.url, pageUrl).pathname === path) return key; } catch { /* not a URL */ }
  }
  return null;
}

/** The short panel: asked, sent, recorded outcome. */
export function mountHandshakePanel(doc, run, { worldLabel } = {}) {
  const old = doc.getElementById("wow-handshake-panel");
  if (old) old.remove();
  const el = doc.createElement("aside");
  el.id = "wow-handshake-panel";
  el.setAttribute("aria-label", "Identity handshake");
  el.style.cssText = [
    "position:fixed", "right:16px", "top:84px", "z-index:60", "max-width:min(360px, calc(100vw - 32px))",
    "background:rgba(14,18,30,0.92)", "color:#e8ecf4", "border:1px solid rgba(140,170,255,0.35)", "border-radius:10px",
    "padding:12px 14px", "font:13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif", "box-shadow:0 6px 24px rgba(0,0,0,0.35)",
  ].join(";");
  const { result, record, user } = run;
  const row = (title, body) => `<div style="margin-top:8px"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9fb0d0">${title}</div><div>${body}</div></div>`;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const asked = result.asked.map((c) => `${esc(label(c.name))} <span style="color:#9fb0d0">(${c.required ? "required" : "optional"})</span>`).join(", ") || "nothing";
  const named = result.world && result.world.identity && result.world.identity.label;
  const parts = [`<div style="font-weight:600">Entering ${esc(named || worldLabel || result.base)}</div><div style="color:#9fb0d0;font-size:12px">${esc(result.base)}${result.refused ? "" : " (its base URL, checked before sending)"}</div>`];
  parts.push(row("The world asked for", asked));
  if (result.refused) {
    parts.push(row("Sent", `nothing. ${esc(result.refused)}`));
  } else {
    const held = Object.keys(labWallet("http://x/").claims);
    const notAsked = held.filter((n) => !result.asked.some((c) => c.name === n));
    parts.push(row("Sent", `${result.sent.map((n) => esc(label(n))).join(", ") || "nothing"}${result.pilot ? `<br><span style="color:#9fb0d0">Pilot statement: ${esc(result.pilot)}</span>` : ""}${notAsked.length ? `<br><span style="color:#9fb0d0">Kept back, not asked for: ${notAsked.map((n) => esc(label(n))).join(", ")}</span>` : ""}`));
    const outcome = record ? record.outcome : (result.answer && result.answer.outcome);
    const colour = outcome === "proceed" ? "#7fe0a0" : outcome === "deny" ? "#ff9a8a" : "#ffd27a";
    const sat = (record ? record.satisfied : []).map((c) => `${esc(label(c.name))} (${esc(c.trust || "")})`).join(", ");
    const unsat = (record ? record.not_satisfied : []).map((c) => `${esc(label(c.name))}: ${esc(c.reason || "")}`).join("; ");
    parts.push(row("Recorded outcome", `<b style="color:${colour}">${esc(outcome || "none")}</b>${record ? "" : " <span style=\"color:#ff9a8a\">(no record)</span>"}`
      + (sat ? `<br>Satisfied: ${sat}` : "") + (unsat ? `<br>Not satisfied: ${unsat}` : "")));
    if (user) parts.push(row("The world's User", `<b data-wow-user-label>${esc(userLabel(user))}</b>`));
  }
  el.innerHTML = parts.join("");
  doc.body.appendChild(el);
  return el;
}

/**
 * The page's side, after the join: `select(user)` lets the page choose, through its own setters, the avatar
 * variant and the preferred height the world accepted (it returns { variant, preferred_height_m }, each null when
 * not applied); `rendered()` reads what the page draws. Shows the panel, and publishes the run as
 * `window.__wowHandshake` and `data-wow-handshake` on the body. Returns the published record, or null when the
 * world states no handshake.
 */
export async function presentHandshake({ hostUrl, pageUrl, fetch: f, document: doc, window: win, select, rendered, worldLabel, logLine }) {
  try {
    const run = await runHandshake({ hostUrl, pageUrl, fetch: f });
    if (!run) return null;
    const applied = (run.user && select ? select(run.user) : null) || { variant: null, preferred_height_m: null };
    mountHandshakePanel(doc, run, { worldLabel });
    const { result, record, user } = run;
    win.__wowHandshake = {
      asked: result.asked, sent: result.sent, refused: result.refused, status: result.status,
      answer: result.answer, record, user, applied, pilot: result.pilot, label: user ? userLabel(user) : null,
      rendered: () => (rendered ? rendered() : null),
    };
    doc.body.setAttribute("data-wow-handshake", JSON.stringify({
      outcome: record ? record.outcome : (result.answer && result.answer.outcome) || null,
      refused: result.refused, sent: result.sent, applied,
    }));
    logLine?.(result.refused ? `wow handshake: sent nothing (${result.refused})` : `wow handshake: ${result.answer && result.answer.outcome} (sent ${result.sent.join(", ")})`);
    return win.__wowHandshake;
  } catch (e) {
    doc.body.setAttribute("data-wow-handshake", JSON.stringify({ error: (e && e.message) || String(e) }));
    logLine?.(`wow handshake ERROR: ${(e && e.message) || e}`);
    return null;
  }
}
