// Glassline AR HUD — airport overlay layer
//
// ADDITIVE overlay. Creates a transparent DOM plane over the airport WebGL
// canvas and drives it each frame from the scene camera — the CSS2DRenderer
// technique (HANDOFF.md §14): world points projected through the camera, plain
// DOM billboarded on top, so `backdrop-filter` glass blur samples the 3D scene
// behind it. Implemented natively (no THREE.CSS2DRenderer vendor fetch) to stay
// self-contained; behaviour is identical (auto-billboard and backdrop blur).
//
// It does NOT touch avatar / movement / camera / portal / render-pipeline logic.
// It runs its own requestAnimationFrame loop reading the (unmodified) camera, so
// the existing WebGL render loop is never edited.

import { createEntityTag } from "./glassline-entity-tag.mjs";

const CSS_HREF = "hud/glassline-hud.css";
const ASSET_BASE = "assets/hud/";

// Entity → accepted local profile-image slug.
const STOREFRONT_MAP = {
  "Skyline Coffee": "storefront-skyline-coffee",
  "Frontier News & Travel": "storefront-frontier-news",
  "High Plains Duty Free": "storefront-high-plains-duty-free",
  "Mesa Kitchen": "storefront-mesa-kitchen",
};
const TRAVELER_MAP = {
  Joe: "person-joe",
  Rose: "person-rose",
  Helium: "person-helium",
  Nea: "person-nea",
  Jane: "person-jane",
};

// Float tags this far above each entity's base (metres).
const STOREFRONT_TAG_Y = 4.4;
const TRAVELER_TAG_Y = 2.35;

// Distance still drives culling, but the selected compact profile/name
// capsule is the only rendered identity tier. Distant or overlapping entities
// are hidden instead of falling back to a full pill, photo badge, or dot.
const LOD_NEAR = 2;
const LOD_FAR = 30;
const COMPACT_LOD = 55;
const HIDDEN_LOD_CUTOFF = 20;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Approximate on-screen half-extent (px) for compact-capsule de-overlap.
function compactHalfRect(entity) {
  const n = String(entity.name || "").length;
  return { hw: Math.min(180, 26 + n * 6), hh: 23 };
}

function rectsOverlap(a, b, margin = 3) {
  return (
    Math.abs(a.cx - b.cx) < a.hw + b.hw + margin &&
    Math.abs(a.cy - b.cy) < a.hh + b.hh + margin
  );
}

function nodePosition(node) {
  const m = node && Array.isArray(node.localTransform) ? node.localTransform : null;
  return m && m.length === 16
    ? [Number(m[12]) || 0, Number(m[13]) || 0, Number(m[14]) || 0]
    : [0, 0, 0];
}

function ensureStylesheet(doc) {
  if (!doc || !doc.head) return;
  if (doc.querySelector('link[data-glassline-hud="1"]')) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.setAttribute("data-glassline-hud", "1");
  doc.head.appendChild(link);
}

function buildEntities(stores, travelers) {
  const out = [];
  for (const node of stores || []) {
    const slug = STOREFRONT_MAP[node && node.label];
    if (!slug) continue;
    const [x, , z] = nodePosition(node);
    out.push({
      slug,
      name: node.label,
      accent: "green",
      x,
      y: STOREFRONT_TAG_Y,
      z,
    });
  }
  for (const node of travelers || []) {
    const ext = (node && node.webofworlds_extension) || {};
    const name = ext.actor && ext.actor.display_name;
    const slug = TRAVELER_MAP[name];
    if (!slug) continue;
    const [x, , z] = nodePosition(node);
    out.push({
      slug,
      name,
      accent: "cyan",
      x,
      y: TRAVELER_TAG_Y,
      z,
    });
  }
  return out;
}

/**
 * initAirportHudOverlay({ THREE, camera, scene, document, stores, travelers, host })
 * Mounts one passive compact identity tag above each of the 9 Airport entities.
 * Returns a handle { dispose, entityCount, layer } or null.
 */
export function initAirportHudOverlay(options = {}) {
  const { THREE, camera, scene } = options;
  const doc =
    options.document || (typeof document !== "undefined" ? document : null);
  const raf = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame : null;

  // Fail-safe env guard: skip entirely in headless/Node (builder proof) contexts.
  if (!THREE || !camera || !doc || typeof doc.createElement !== "function" || !raf) {
    return null;
  }
  const host =
    options.host || (typeof doc.getElementById === "function" ? doc.getElementById("scene-mount") : null);
  if (!host) return null;

  let manifestCardLayer = null;
  let manifestCardLayerWasVisible = false;
  try {
    // Idempotent: dispose any overlay from a previous airport mount on this host.
    if (host.__glasslineHud && typeof host.__glasslineHud.dispose === "function") {
      host.__glasslineHud.dispose();
    }

    // Keep the canonical manifest records/meshes alive for data and lifecycle
    // continuity, but remove their legacy large identity-card presentation from
    // the selected Airport. Portal previews mount without this page HUD.
    manifestCardLayer =
      scene && typeof scene.getObjectByName === "function"
        ? scene.getObjectByName("airport-entity-manifest-cards")
        : null;
    if (manifestCardLayer) {
      manifestCardLayerWasVisible = manifestCardLayer.visible;
      manifestCardLayer.visible = false;
    }

    ensureStylesheet(doc);

    const layer = doc.createElement("div");
    layer.className = "glassline-hud-layer";
    layer.setAttribute("data-glassline-hud-layer", "1");
    host.appendChild(layer);

    const entities = buildEntities(options.stores, options.travelers);

    for (const entity of entities) {
      const wrapper = doc.createElement("div");
      wrapper.className = "glassline-anchor";
      wrapper.setAttribute("data-slug", entity.slug);
      const tag = createEntityTag({
        title: entity.name,
        slotId: `hud-${entity.slug}`,
        src: `${ASSET_BASE}${entity.slug}--profile.jpg`,
        accent: entity.accent,
        lod: COMPACT_LOD,
      });
      wrapper.appendChild(tag.el);
      layer.appendChild(wrapper);
      entity.wrapper = wrapper;
      entity.tag = tag;
      entity.world = new THREE.Vector3(entity.x, entity.y, entity.z);
    }

    const ndc = new THREE.Vector3();
    let frameId = 0;
    let stopped = false;

    function frame() {
      if (stopped) return;
      try {
        // Keep the overlay alive only while its canvas host is in the DOM.
        if (!layer.isConnected) {
          dispose();
          return;
        }
        const w = layer.clientWidth || host.clientWidth || 1;
        const h = layer.clientHeight || host.clientHeight || 1;
        camera.updateMatrixWorld();

        // Pass 1 — project every anchor, cull behind/offscreen, and compute the
        // hide cutoff from true camera distance.
        const visible = [];
        for (const entity of entities) {
          ndc.copy(entity.world).project(camera);
          const behind = ndc.z > 1;
          const offscreen =
            ndc.x < -1.4 || ndc.x > 1.4 || ndc.y < -1.4 || ndc.y > 1.4;
          if (behind || offscreen) {
            entity.wrapper.style.display = "none";
            entity.wrapper.style.pointerEvents = "none";
            entity.wrapper.removeAttribute("data-tier");
            continue;
          }
          entity.sx = (ndc.x * 0.5 + 0.5) * w;
          entity.sy = (-ndc.y * 0.5 + 0.5) * h;
          entity.dist = camera.position.distanceTo(entity.world);
          entity.baseLod = clamp(
            100 - ((entity.dist - LOD_NEAR) / (LOD_FAR - LOD_NEAR)) * 100,
            0,
            100,
          );
          visible.push(entity);
        }

        // Pass 2 — nearest compact capsule wins each overlapping screen-space
        // rectangle. Distance and overlap hide labels instead of changing tier.
        visible.sort((a, b) => a.dist - b.dist);
        const placed = [];
        for (const entity of visible) {
          const compactRect = {
            cx: entity.sx,
            cy: entity.sy,
            ...compactHalfRect(entity),
          };
          const hiddenByDistance = entity.baseLod < HIDDEN_LOD_CUTOFF;
          const hiddenByOverlap =
            !hiddenByDistance &&
            placed.some((placedRect) => rectsOverlap(compactRect, placedRect));
          if (hiddenByDistance || hiddenByOverlap) {
            entity.finalTier = null;
            continue;
          }
          entity.finalTier = "compact";
          placed.push(compactRect);
        }

        // Pass 3 — apply compact visibility, position, and depth order.
        for (const entity of visible) {
          if (entity.finalTier !== "compact") {
            entity.wrapper.style.display = "none";
            entity.wrapper.style.pointerEvents = "none";
            entity.wrapper.removeAttribute("data-tier");
            continue;
          }
          entity.wrapper.style.display = "";
          entity.wrapper.style.pointerEvents = "";
          entity.wrapper.setAttribute("data-tier", "compact");
          entity.wrapper.style.transform = `translate(-50%,-50%) translate(${entity.sx}px,${entity.sy}px)`;
          entity.wrapper.style.zIndex = String(Math.round(30000 - entity.dist * 100));
          entity.tag.update({ lod: COMPACT_LOD });
        }
      } catch (err) {
        // Never let a HUD hiccup break the scene; log once and keep going.
        if (!frame.__warned) {
          frame.__warned = true;
          console.warn("[glassline-hud] frame error (overlay continues):", err);
        }
      }
      frameId = raf(frame);
    }

    function dispose() {
      if (stopped) return;
      stopped = true;
      if (frameId && caf) caf(frameId);
      frameId = 0;
      if (layer.parentNode) layer.parentNode.removeChild(layer);
      if (manifestCardLayer) {
        manifestCardLayer.visible = manifestCardLayerWasVisible;
      }
      if (host.__glasslineHud === handle) delete host.__glasslineHud;
      if (typeof window !== "undefined" && window.__glasslineAirportHud === handle) {
        delete window.__glasslineAirportHud;
      }
    }

    const handle = {
      dispose,
      entityCount: entities.length,
      layer,
      manifestCardCount: manifestCardLayer?.children?.length || 0,
      legacyIdentityCardsHidden: Boolean(manifestCardLayer) && manifestCardLayer.visible === false,
    };
    host.__glasslineHud = handle;
    if (typeof window !== "undefined") window.__glasslineAirportHud = handle;
    frameId = raf(frame);
    return handle;
  } catch (err) {
    if (manifestCardLayer) {
      manifestCardLayer.visible = manifestCardLayerWasVisible;
    }
    console.warn("[glassline-hud] init failed (airport scene unaffected):", err);
    return null;
  }
}

export default { initAirportHudOverlay };
