/**
 * render-quality-levers.mjs —
 *
 * The two visible compositor cost levers, resolved ONCE at boot from
 * `location.search`, in one place, so the demo cannot drift between the sites
 * that consume them.
 *
 *   ?glass=off | on | <px>     backdrop-filter frosting on the header, the rail
 *                              and the runtime tweak palette (audit finding F5).
 *   ?dpr_cap=<ratio>           devicePixelRatio clamp for the WebGL renderers
 *                              (audit finding F9).
 *
 * WHY A MODULE AND NOT THREE LITERALS. F9's clamp is applied at THREE sites —
 * `web/app.js` measureLiveViewport, `web/scene-runtime-controller.mjs` resize,
 * and the vendor/scene-core `scene.js` constructor. The resize path re-applies the
 * clamp on every window resize and every world crossing, so a clamp that is
 * lowered at only one or two of them is silently re-raised the first time the
 * user drags a window edge. One exported constant removes that failure mode.
 *
 * READ-ONLY URL. Same discipline as the rest of app.js: the params are read at
 * boot and never written back (the no-reload guard treats a pushState as
 * a navigation). Absent params => the defaults below.
 *
 * DEFAULTS ARE A PRODUCT DECISION.
 *
 * STATUS 2026-08-06: both arms were APPROVED on measured evidence
 * (glass measured at -8.49 points of one core in the after-baseline), but
 * NEITHER DEFAULT HAS BEEN CHANGED YET. Both constants below still hold the
 * shipped values (glass "on", cap 2). The lane implementing the flip was
 * terminated by a session usage limit after landing these levers and before
 * changing the defaults or capturing the required before/after screenshots.
 *
 * Do not read the approval as applied. Applying it is a two-line change to the
 * constants below, but it is gated on two things the terminated lane never did:
 * (1) before/after screenshots so the user can see the cosmetic cost, and
 * (2) confirming the pixel-ratio clamp is consistent across all three sites —
 *     runtime/scene-core/scene.js still holds literal
 *     `Math.min(..., 2)` at :77 and :196, and this module is only wired into the
 *     authoritative resize clamp in scene-runtime-controller.mjs.
 *
 * Reverting either arm later is a one-line change to the constant below, NOT a
 * rollback of this module — the levers stay either way, because presenters need
 * them for screenshots.
 */

/** Glass frosting default. "off" => solid panel fill, no backdrop-filter. */
export const DEFAULT_GLASS_MODE = "on";
/** The frosting radius the design shipped with; also the `?glass=on` value. */
export const DESIGN_GLASS_BLUR_PX = 20;
/** devicePixelRatio clamp. Was 2 (4x fragment work on Retina) until. */
export const DEFAULT_PIXEL_RATIO_CAP = 2;
/** The clamp the demo shipped with, kept named so `?dpr_cap=2` is documented. */
export const LEGACY_PIXEL_RATIO_CAP = 2;

const GLASS_BLUR_MIN_PX = 1;
const GLASS_BLUR_MAX_PX = 40;
const PIXEL_RATIO_CAP_MIN = 1;
const PIXEL_RATIO_CAP_MAX = 3;

const GLASS_OFF_TOKENS = new Set(["off", "none", "false", "0", "solid"]);
const GLASS_ON_TOKENS = new Set(["on", "true", "blur", "default"]);

/**
 * Absent params are `null`, and `Number(null)` is 0 — which would clamp to the
 * minimum instead of falling back. Every read here goes through this guard.
 */
function finiteParam(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function searchParams(search) {
  if (search instanceof URLSearchParams) return search;
  if (typeof search === "string") return new URLSearchParams(search);
  return new URLSearchParams("");
}

/**
 * @returns {{mode: "on"|"off", blur_px: number, source: "default"|"query", raw: string|null}}
 */
export function resolveGlassLever(search) {
  const params = searchParams(search);
  const raw = params.get("glass");
  if (raw === null) {
    return {
      mode: DEFAULT_GLASS_MODE,
      blur_px: DESIGN_GLASS_BLUR_PX,
      source: "default",
      raw: null,
    };
  }
  const token = String(raw).trim().toLowerCase();
  if (GLASS_OFF_TOKENS.has(token)) {
    return { mode: "off", blur_px: DESIGN_GLASS_BLUR_PX, source: "query", raw };
  }
  if (GLASS_ON_TOKENS.has(token)) {
    return { mode: "on", blur_px: DESIGN_GLASS_BLUR_PX, source: "query", raw };
  }
  const numeric = finiteParam(token.endsWith("px") ? token.slice(0, -2) : token);
  if (numeric === null) {
    return {
      mode: DEFAULT_GLASS_MODE,
      blur_px: DESIGN_GLASS_BLUR_PX,
      source: "default",
      raw,
    };
  }
  if (numeric <= 0) {
    return { mode: "off", blur_px: DESIGN_GLASS_BLUR_PX, source: "query", raw };
  }
  return {
    mode: "on",
    blur_px: clamp(numeric, GLASS_BLUR_MIN_PX, GLASS_BLUR_MAX_PX),
    source: "query",
    raw,
  };
}

/**
 * @returns {{cap: number, source: "default"|"query", raw: string|null}}
 */
export function resolvePixelRatioCapLever(search) {
  const params = searchParams(search);
  const raw = params.get("dpr_cap");
  const numeric = finiteParam(raw);
  if (numeric === null) {
    return { cap: DEFAULT_PIXEL_RATIO_CAP, source: "default", raw };
  }
  return {
    cap: clamp(numeric, PIXEL_RATIO_CAP_MIN, PIXEL_RATIO_CAP_MAX),
    source: "query",
    raw,
  };
}

function currentSearch(view) {
  const host = view || (typeof window !== "undefined" ? window : null);
  return (host && host.location && host.location.search) || "";
}

let detachedResolution = null;

/**
 * The boot-time resolution, memoised ON THE VIEW rather than in module scope —
 * proofs and unit checks drive several fake windows through one process, and a
 * module-scope memo would leak the first window's arm into all of them.
 *
 * Publishing it on the window is not decoration: `/vendor/scene-core/scene.js` is a
 * read-only lane snapshot that must stay servable on its own, so it cannot
 * import this module — it reads the published cap instead. Proof scripts read
 * it too, which is how the A/B evidence records which arm actually ran.
 */
export function renderQualityLevers(view) {
  const host = view || (typeof window !== "undefined" ? window : null);
  if (host && host.__oslRenderQuality) return host.__oslRenderQuality;
  if (!host && detachedResolution) return detachedResolution;
  const search = currentSearch(host);
  const glass = resolveGlassLever(search);
  const pixelRatio = resolvePixelRatioCapLever(search);
  const value = Object.freeze({
    glass_mode: glass.mode,
    glass_blur_px: glass.blur_px,
    glass_source: glass.source,
    pixel_ratio_cap: pixelRatio.cap,
    pixel_ratio_cap_source: pixelRatio.source,
    defaults: Object.freeze({
      glass_mode: DEFAULT_GLASS_MODE,
      pixel_ratio_cap: DEFAULT_PIXEL_RATIO_CAP,
    }),
  });
  if (host) host.__oslRenderQuality = value;
  else detachedResolution = value;
  return value;
}

/** The clamp itself, so the three F9 sites cannot disagree about the formula. */
export function clampPixelRatio(devicePixelRatio, cap) {
  const ratio = Number(devicePixelRatio);
  const ceiling = Number.isFinite(Number(cap)) ? Number(cap) : DEFAULT_PIXEL_RATIO_CAP;
  return Math.max(1, Math.min(ceiling, Number.isFinite(ratio) && ratio > 0 ? ratio : 1));
}

/** Convenience for the F9 sites: resolve the boot cap and apply it in one call. */
export function pixelRatioFor(devicePixelRatio, view) {
  return clampPixelRatio(devicePixelRatio, renderQualityLevers(view).pixel_ratio_cap);
}

/** Test seam only — the boot read is memoised, and proofs need a fresh read. */
export function resetRenderQualityLevers(view) {
  const host = view || (typeof window !== "undefined" ? window : null);
  if (host) delete host.__oslRenderQuality;
  detachedResolution = null;
}
