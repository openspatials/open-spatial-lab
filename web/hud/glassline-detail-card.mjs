// Glassline "Detail Card" — native DOM factory
//
// Native reimplementation of design/ar-interface-component-library/.../Detail Card.dc.html.
// The DC React runtime (support.js) is NOT vendored; the renderVals() logic
// (Detail Card.dc.html:95-132) is translated to plain JS and the inline styles
// are reproduced VERBATIM (the .dc.html is the pixel spec). The image-slot dev
// placeholder is replaced by a real <img> hero per HANDOFF.md §5.
//
// Collapsed = glass pill header; open = full-bleed 4:3 hero + header overlaid on
// the scrim + info rows. Clicking the header toggles open/collapsed.

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CARD_BG =
  "linear-gradient(170deg,rgba(255,255,255,0.15),rgba(150,205,255,0.06) 40%,rgba(8,20,36,0.32))";
const CARD_SHADOW =
  "0 10px 34px rgba(0,15,35,0.45),inset 0 1px 0 rgba(255,255,255,0.35)";
// Hero scrim — verbatim Detail Card.dc.html:26 / HANDOFF.md §12.
const HERO_SCRIM =
  "linear-gradient(180deg,rgba(8,18,32,0.78),rgba(8,18,32,0.3) 52%,rgba(8,20,36,0.02))";

// Icon circle used in both hero-overlay and plain-header (Detail Card.dc.html:29,44).
function iconHtml(icon, withBlur) {
  return (
    `<div style="width:34px;height:34px;border-radius:50%;background:rgba(127,216,255,0.25);` +
    `border:1.5px solid rgba(180,228,255,0.9);${withBlur ? "backdrop-filter:blur(6px);" : ""}` +
    `display:grid;place-items:center;color:#c9ecff;font-size:15px;font-weight:700;flex:none">` +
    `${esc(icon)}</div>`
  );
}

// Hero header overlay (Detail Card.dc.html:27-39).
function heroHeaderHtml(v) {
  const stars = v.hasStars
    ? `<div style="padding:2px 18px 0"><span style="font-size:14px;font-weight:700;color:#ffd34d;` +
      `text-shadow:0 1px 6px rgba(0,15,35,0.8)">${esc(v.stars)} ` +
      `<span style="color:rgba(255,255,255,0.92);font-weight:600">${esc(v.starsNote)}</span></span></div>`
    : "";
  return (
    `<div style="position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column;gap:2px;pointer-events:none">` +
    `<div style="display:flex;align-items:center;gap:12px;padding:13px 18px 0">` +
    iconHtml(v.icon, true) +
    `<div style="display:flex;flex-direction:column;flex:1">` +
    `<span style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;` +
    `color:rgba(255,255,255,0.85);text-shadow:0 1px 6px rgba(0,15,35,0.7)">${esc(v.kicker)}</span>` +
    `<span style="font-size:23px;font-weight:700;letter-spacing:0.03em;color:#fff;line-height:1.05;` +
    `text-shadow:0 1px 8px rgba(0,15,35,0.8)">${esc(v.headline)}</span></div>` +
    `<span style="font-size:15px;color:rgba(255,255,255,0.85)">${esc(v.chevron)}</span></div>` +
    stars +
    `</div>`
  );
}

// Full-bleed hero (Detail Card.dc.html:23-40). Real <img> replaces image-slot.
function heroHtml(v) {
  return (
    `<div data-glassline-toggle="1" style="cursor:pointer;position:relative;height:${v.imageHeight}">` +
    `<div style="position:absolute;inset:0"><img src="${esc(v.src)}" alt="" draggable="false" ` +
    `style="width:100%;height:100%;object-fit:cover;display:block"></div>` +
    `<div style="position:absolute;inset:0;background:${HERO_SCRIM};pointer-events:none"></div>` +
    heroHeaderHtml(v) +
    `</div>`
  );
}

// Collapsed plain pill header (Detail Card.dc.html:42-51).
function plainHeaderHtml(v) {
  return (
    `<div data-glassline-toggle="1" style="cursor:pointer;display:flex;align-items:center;gap:12px;padding:13px 18px">` +
    iconHtml(v.icon, false) +
    `<div style="display:flex;flex-direction:column;flex:1">` +
    `<span style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;` +
    `color:rgba(255,255,255,0.68)">${esc(v.kicker)}</span>` +
    `<span style="font-size:23px;font-weight:700;letter-spacing:0.03em;color:#fff;line-height:1.05">${esc(v.headline)}</span></div>` +
    `<span style="font-size:15px;color:rgba(255,255,255,0.75)">${esc(v.chevron)}</span></div>`
  );
}

// Open body block (Detail Card.dc.html:52-88): bold row / meta row / body.
function bodyHtml(v) {
  let rows = "";
  if (v.hasBoldRow) {
    rows +=
      `<div style="display:flex;justify-content:space-between;align-items:baseline">` +
      `<span style="font-size:16px;font-weight:700;color:#fff">${esc(v.boldLeft)}</span>` +
      `<span style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.75)">${esc(v.boldRight)}</span></div>`;
  }
  if (v.hasMetaRow) {
    rows +=
      `<div style="display:flex;justify-content:space-between;align-items:baseline">` +
      `<span style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.65)">${esc(v.metaLeft)}</span>` +
      `<span style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.65)">${esc(v.metaRight)}</span></div>`;
  }
  if (v.hasBody) {
    rows +=
      `<div style="font-size:14px;font-weight:500;color:rgba(255,255,255,0.88);line-height:1.45">${esc(v.body)}</div>`;
  }
  if (!rows) return "";
  return `<div style="display:flex;flex-direction:column;gap:11px;padding:12px 18px 16px">${rows}</div>`;
}

function iconBadgeHtml(v) {
  // tierBadge (Detail Card.dc.html:16-19)
  return (
    `<div style="display:inline-grid;place-items:center;width:48px;height:48px;border-radius:50%;` +
    `border:2px solid rgba(255,255,255,0.8);background:${CARD_BG};backdrop-filter:blur(12px);font-family:'Rajdhani',sans-serif">` +
    `<div style="width:34px;height:34px;border-radius:50%;background:rgba(127,216,255,0.25);` +
    `border:1.5px solid rgba(180,228,255,0.9);display:grid;place-items:center;color:#c9ecff;font-size:15px;font-weight:700">` +
    `${esc(v.icon)}</div></div>`
  );
}

// Translate props+state -> render values (Detail Card.dc.html:95-132).
function computeVals(props, open) {
  const p = props;
  return {
    tierCard: true,
    width: p.width ?? "318px",
    icon: p.icon ?? "⬖", // design default glyph (Detail Card.dc.html)
    kicker: p.kicker ?? "Ride arriving",
    headline: p.headline ?? "Now",
    chevron: open ? "▲" : "▼", // ▲ / ▼
    open,
    hasStars: !!p.stars,
    stars: p.stars,
    starsNote: p.starsNote,
    src: p.src ?? "",
    imageHeight: p.imageHeight ?? "190px",
    // hasBoldRow default true unless boldLeft explicitly "" (Detail Card.dc.html:125).
    hasBoldRow: !!(p.boldLeft ?? true),
    boldLeft: p.boldLeft ?? "Sedan · White",
    boldRight: p.boldRight ?? "7ABC123",
    hasMetaRow: !!p.metaLeft,
    metaLeft: p.metaLeft,
    metaRight: p.metaRight,
    hasBody: !!p.body,
    body: p.body,
  };
}

function cardShellHtml(v, inner) {
  return (
    `<div style="width:${v.width};border-radius:24px;border:1.5px solid rgba(255,255,255,0.8);` +
    `background:${CARD_BG};backdrop-filter:blur(14px);box-shadow:${CARD_SHADOW};overflow:hidden;` +
    `font-family:'Rajdhani',sans-serif">${inner}</div>`
  );
}

/**
 * createDetailCard(props) -> { el, setOpen, isOpen, update }
 * props: { kicker, headline, icon, src, width, imageHeight, defaultOpen,
 *          boldLeft, boldRight, metaLeft, metaRight, body, stars, starsNote, onToggle }
 */
export function createDetailCard(props = {}) {
  const el = document.createElement("div");
  el.className = "glassline-card";
  let current = { ...props };
  let open = props.defaultOpen ?? true;

  function render() {
    const v = computeVals(current, open);
    const inner = open ? heroHtml(v) + bodyHtml(v) : plainHeaderHtml(v);
    el.innerHTML = cardShellHtml(v, inner);
    const header = el.querySelector('[data-glassline-toggle="1"]');
    if (header) {
      header.addEventListener("click", (event) => {
        event.stopPropagation();
        setOpen(!open);
        if (typeof current.onToggle === "function") current.onToggle(open);
      });
    }
  }

  function setOpen(next) {
    const value = !!next;
    if (value === open) return;
    open = value;
    render();
  }

  function update(next = {}) {
    current = { ...current, ...next };
    render();
  }

  render();
  return {
    el,
    setOpen,
    isOpen: () => open,
    update,
  };
}

export default { createDetailCard };
