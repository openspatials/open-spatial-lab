// Glassline "Entity Tag" — native DOM factory
//
// Native reimplementation of design/ar-interface-component-library/.../Entity Tag.dc.html.
// The DC React runtime (support.js) is NOT vendored; the renderVals() tier/accent
// logic (Entity Tag.dc.html:56-79) is translated to plain JS and the inline
// styles are reproduced VERBATIM (the .dc.html is the pixel spec). Dev-only
// image-slot placeholders are replaced by real <img> per HANDOFF.md §5.
//
// Shape mirrors web/image-slot.js style: a small module exporting a factory that
// returns { el, update } with no framework dependency.

// Accent map — verbatim from Entity Tag.dc.html:57-62.
const ACC = {
  green: { badge: "#ffffff", fg: "#0b1420", bar: "linear-gradient(90deg,#3fca74,#8df0ae)", dot: "#57e389" },
  yellow: { badge: "#ffd34d", fg: "#241a00", bar: "linear-gradient(90deg,#e8b93c,#ffd97a)", dot: "#ffd34d" },
  red: { badge: "#ff5c5c", fg: "#ffffff", bar: "linear-gradient(90deg,#e0403f,#ff8a7a)", dot: "#ff5c5c" },
  cyan: { badge: "#7fd8ff", fg: "#062033", bar: "linear-gradient(90deg,#5cc9ff,#c8ecff)", dot: "#7fd8ff" },
};

const GLASS_SHADOW = "0 6px 24px rgba(0,15,35,0.35),inset 0 1px 0 rgba(255,255,255,0.35)";

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Translate props -> render values (Entity Tag.dc.html:56-79, verbatim logic).
function computeVals(props) {
  const acc = ACC[props.accent ?? "green"] || ACC.green;
  const sel = props.selected ?? false;
  const alert = props.accent === "red";
  const lod = Math.max(0, Math.min(100, props.lod ?? 100));
  return {
    tierFull: lod >= 70,
    tierCompact: lod >= 40 && lod < 70,
    tierBadge: lod >= 20 && lod < 40,
    tierDot: lod < 20,
    title: props.title ?? "Nomi Sushi",
    value: props.value ?? "0.1 mi",
    badge: props.badge ?? "4.6",
    hasSlot: !!props.slotId,
    src: props.src ?? "",
    badgeBg: acc.badge,
    badgeFg: acc.fg,
    bar: acc.bar,
    dotColor: sel ? "#7fd8ff" : acc.dot,
    pct: (props.progress ?? 84) + "%",
    borderColor: sel
      ? "rgba(180,228,255,0.95)"
      : alert
        ? "rgba(255,120,120,0.85)"
        : "rgba(255,255,255,0.78)",
    glassBg: sel
      ? "linear-gradient(165deg,rgba(160,220,255,0.5),rgba(70,150,235,0.32))"
      : alert
        ? "linear-gradient(165deg,rgba(255,150,150,0.2),rgba(255,90,90,0.08) 45%,rgba(36,8,12,0.3))"
        : "linear-gradient(165deg,rgba(255,255,255,0.16),rgba(150,205,255,0.07) 45%,rgba(8,20,36,0.3))",
    anim: sel ? "glowPulse 2.6s ease-in-out infinite" : "none",
    barAnim: (props.drain ?? false) ? "drain 7s linear infinite alternate" : "none",
  };
}

// A real <img> circle badge (replaces image-slot dev placeholder — HANDOFF.md §5).
function photoHtml(src, sizePx) {
  return (
    `<div style="width:${sizePx}px;height:${sizePx}px;border-radius:50%;overflow:hidden;` +
    `border:2px solid rgba(255,255,255,0.9);flex:none">` +
    `<img src="${esc(src)}" alt="" draggable="false" ` +
    `style="width:100%;height:100%;object-fit:cover;display:block"></div>`
  );
}

function glyphBadgeHtml(v, sizePx, fontPx) {
  return (
    `<div style="width:${sizePx}px;height:${sizePx}px;border-radius:50%;background:${v.badgeBg};` +
    `color:${v.badgeFg};display:grid;place-items:center;font-weight:700;font-size:${fontPx}px;flex:none">` +
    `${esc(v.badge)}</div>`
  );
}

function renderHtml(v) {
  if (v.tierFull) {
    const media = v.hasSlot ? photoHtml(v.src, 44) : glyphBadgeHtml(v, 42, 16);
    return (
      `<div style="display:inline-flex;align-items:center;gap:12px;padding:7px 20px 7px 7px;` +
      `border-radius:999px;border:1.5px solid ${v.borderColor};background:${v.glassBg};` +
      `backdrop-filter:blur(12px);box-shadow:${GLASS_SHADOW};animation:${v.anim}">` +
      media +
      `<div style="display:flex;flex-direction:column;gap:4px;min-width:160px">` +
      `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px">` +
      `<span style="font-size:18px;font-weight:700;letter-spacing:0.03em;color:#fff">${esc(v.title)}</span>` +
      `<span style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.78)">${esc(v.value)}</span></div>` +
      `<div style="height:6px;border-radius:4px;background:rgba(10,20,35,0.55);overflow:hidden">` +
      `<div style="width:${v.pct};height:100%;border-radius:4px;background:${v.bar};animation:${v.barAnim}"></div>` +
      `</div></div></div>`
    );
  }
  if (v.tierCompact) {
    const media = v.hasSlot ? photoHtml(v.src, 36) : glyphBadgeHtml(v, 34, 14);
    return (
      `<div style="display:inline-flex;align-items:center;gap:10px;padding:5px 18px 5px 5px;` +
      `border-radius:999px;border:1.5px solid ${v.borderColor};background:${v.glassBg};` +
      `backdrop-filter:blur(12px);box-shadow:${GLASS_SHADOW};animation:${v.anim}">` +
      media +
      `<span style="font-size:20px;font-weight:700;letter-spacing:0.04em;color:#fff;` +
      `white-space:nowrap;padding-right:2px">${esc(v.title)}</span></div>`
    );
  }
  if (v.tierBadge) {
    // Circular badge: profile photo when the entity has one (demo
    // polish), otherwise the glyph badge from the design spec.
    const inner = v.hasSlot
      ? `<div style="width:38px;height:38px;border-radius:50%;overflow:hidden;border:1.5px solid rgba(255,255,255,0.85)">` +
        `<img src="${esc(v.src)}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block"></div>`
      : `<div style="width:36px;height:36px;border-radius:50%;background:${v.badgeBg};color:${v.badgeFg};` +
        `display:grid;place-items:center;font-weight:700;font-size:15px">${esc(v.badge)}</div>`;
    return (
      `<div style="display:inline-grid;place-items:center;width:48px;height:48px;border-radius:50%;` +
      `border:2px solid ${v.borderColor};background:${v.glassBg};backdrop-filter:blur(12px);animation:${v.anim}">` +
      inner +
      `</div>`
    );
  }
  // tierDot
  return (
    `<div style="width:16px;height:16px;border-radius:50%;background:${v.dotColor};` +
    `border:1.5px solid rgba(255,255,255,0.9);box-shadow:0 0 12px ${v.dotColor}"></div>`
  );
}

// Signature of the visually-load-bearing props: rebuild innerHTML only on change
// (the rAF loop calls update() every frame; DOM churn would be wasteful otherwise).
function signature(v) {
  return [
    v.tierFull ? "F" : v.tierCompact ? "C" : v.tierBadge ? "B" : "D",
    v.borderColor,
    v.glassBg,
    v.anim,
    v.title,
    v.value,
    v.badge,
    v.src,
    v.pct,
    v.bar,
    v.barAnim,
  ].join("|");
}

/**
 * createEntityTag(props) -> { el, update(nextProps) }
 * props: { title, value, badge, slotId, src, accent, progress, selected, drain, lod }
 */
export function createEntityTag(props = {}) {
  const el = document.createElement("div");
  el.className = "glassline-tag";
  el.style.fontFamily = "'Rajdhani',sans-serif";
  let current = { ...props };
  let sig = null;

  function update(next = {}) {
    current = { ...current, ...next };
    const vals = computeVals(current);
    const nextSig = signature(vals);
    if (nextSig !== sig) {
      sig = nextSig;
      el.innerHTML = renderHtml(vals);
    }
  }

  update();
  return { el, update };
}

export default { createEntityTag };
