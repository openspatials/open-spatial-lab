// deterministic Airport HUD dot-removal and lifecycle
// ownership guard. Each controlled mutation must fail the same contract that
// the production sources pass.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = async (relative) => (
  await readFile(path.join(ROOT, relative), "utf8")
);

const sources = Object.freeze({
  overlay: await readText("web/hud/airport-hud-overlay.mjs"),
  scene: await readText("web/airport-terminal-scene.mjs"),
  controller: await readText("web/scene-runtime-controller.mjs"),
  tag: await readText("web/hud/glassline-entity-tag.mjs"),
  css: await readText("web/hud/glassline-hud.css"),
  entityRuntime: await readText("web/airport-entity-runtime.mjs"),
});

const count = (source, pattern) => [...source.matchAll(pattern)].length;

function assertContract(candidate) {
  const { overlay, scene, controller, tag, css, entityRuntime } = candidate;

  // supersedes the richer Airport presentation: a visible identity is
  // always the passive compact image/name capsule. Distance, offscreen state,
  // and overlap hide instead of falling back to any other tier.
  assert.match(overlay, /const COMPACT_LOD = 55;/);
  assert.match(overlay, /const HIDDEN_LOD_CUTOFF = 20;/);
  assert.match(overlay, /entity\.finalTier = "compact";/);
  assert.match(
    overlay,
    /if \(entity\.finalTier !== "compact"\) \{\s*entity\.wrapper\.style\.display = "none";\s*entity\.wrapper\.style\.pointerEvents = "none";\s*entity\.wrapper\.removeAttribute\("data-tier"\);\s*continue;/,
  );
  assert.match(
    overlay,
    /entity\.wrapper\.style\.display = "";\s*entity\.wrapper\.style\.pointerEvents = "";\s*entity\.wrapper\.setAttribute\("data-tier", "compact"\);/,
    "only compact anchors may remain visible",
  );
  assert.match(overlay, /entity\.tag\.update\(\{ lod: COMPACT_LOD \}\);/);
  assert.doesNotMatch(overlay, /createDetailCard|glassline-detail-card|glassline-card-anchor|tag\.el\.addEventListener/);
  assert.doesNotMatch(overlay, /["'](?:full|badge|dot)["']/);
  assert.match(tag, /if \(v\.tierCompact\) \{[\s\S]*photoHtml\(v\.src, 36\)[\s\S]*\$\{esc\(v\.title\)\}<\/span><\/div>/);
  assert.match(css, /\.glassline-anchor > \* \{ pointer-events: none; \}/);

  // Preserve manifest/runtime ownership while suppressing the legacy large
  // identity-card presentation only for the selected Airport.
  assert.match(entityRuntime, /group\.name = "airport-entity-manifest-cards";/);
  assert.match(overlay, /getObjectByName\("airport-entity-manifest-cards"\)/);
  assert.match(overlay, /manifestCardLayer\.visible = false;/);
  assert.match(overlay, /manifestCardLayer\.visible = manifestCardLayerWasVisible;/);

  // Airport owns the returned handle on `built`; every maintained entity
  // runtime disposal path must dispose the corresponding HUD first.
  assert.equal(
    count(scene, /built\.airport_hud_overlay = initAirportHudOverlay\(\{/g),
    1,
    "Airport must capture exactly one HUD handle on its built scene owner",
  );
  assert.match(scene, /if \(opts\.hudOverlay !== false\) \{/);
  assert.match(
    controller,
    /\{ document: documentTarget, motionPreference, hudOverlay: false \}/,
    "Airport portal previews must not mount the page-level HUD over Lobby",
  );
  const hudDisposals = count(controller, /built\.airport_hud_overlay\?\.dispose\(\)/g);
  const entityDisposals = count(controller, /built\.airport_entity_runtime\?\.dispose\(\)/g);
  assert.equal(hudDisposals, 2, "portal-preview and selected-renderer exits must dispose the HUD");
  assert.equal(hudDisposals, entityDisposals, "HUD disposal must cover every entity-runtime exit");
  assert.equal(
    count(
      controller,
      /built\.airport_hud_overlay\?\.dispose\(\);[\s\S]{0,120}built\.airport_entity_runtime\?\.dispose\(\);/g,
    ),
    entityDisposals,
    "HUD disposal must remain adjacent to the established Airport runtime owner",
  );

  // Reentry replaces any existing host layer; disposal stops animation,
  // removes DOM, restores the scene-owned manifest group, and releases both
  // the overlay owner and matching debug view.
  assert.match(
    overlay,
    /if \(host\.__glasslineHud && typeof host\.__glasslineHud\.dispose === "function"\) \{\s*host\.__glasslineHud\.dispose\(\);/,
  );
  assert.match(overlay, /if \(frameId && caf\) caf\(frameId\);\s*frameId = 0;/);
  assert.match(overlay, /if \(layer\.parentNode\) layer\.parentNode\.removeChild\(layer\);/);
  assert.match(overlay, /manifestCardLayer\.visible = manifestCardLayerWasVisible;/);
  assert.match(overlay, /if \(host\.__glasslineHud === handle\) delete host\.__glasslineHud;/);
  assert.match(
    overlay,
    /if \(typeof window !== "undefined" && window\.__glasslineAirportHud === handle\) \{\s*delete window\.__glasslineAirportHud;/,
  );
}

function replaceRequired(source, before, after, label) {
  const replaced = source.replace(before, after);
  assert.notEqual(replaced, source, `controlled mutation did not apply: ${label}`);
  return replaced;
}

const redCases = [
  {
    name: "visible_full_tier",
    mutate: (candidate) => ({
      ...candidate,
      overlay: replaceRequired(
        candidate.overlay,
        'entity.wrapper.setAttribute("data-tier", "compact");',
        'entity.wrapper.setAttribute("data-tier", "full");',
        "visible_full_tier",
      ),
    }),
  },
  {
    name: "interactive_compact_label",
    mutate: (candidate) => ({
      ...candidate,
      css: replaceRequired(
        candidate.css,
        ".glassline-anchor > * { pointer-events: none; }",
        ".glassline-anchor > * { pointer-events: auto; }",
        "interactive_compact_label",
      ),
    }),
  },
  {
    name: "missing_handle_capture",
    mutate: (candidate) => ({
      ...candidate,
      scene: replaceRequired(
        candidate.scene,
        "built.airport_hud_overlay = initAirportHudOverlay({",
        "initAirportHudOverlay({",
        "missing_handle_capture",
      ),
    }),
  },
  {
    name: "missing_scene_disposal",
    mutate: (candidate) => ({
      ...candidate,
      controller: replaceRequired(
        candidate.controller,
        "built.airport_hud_overlay?.dispose();",
        "",
        "missing_scene_disposal",
      ),
    }),
  },
  {
    name: "stale_lobby_layer",
    mutate: (candidate) => ({
      ...candidate,
      overlay: replaceRequired(
        candidate.overlay,
        "if (layer.parentNode) layer.parentNode.removeChild(layer);",
        "",
        "stale_lobby_layer",
      ),
    }),
  },
  {
    name: "stale_lobby_preview_hud",
    mutate: (candidate) => ({
      ...candidate,
      controller: replaceRequired(
        candidate.controller,
        ", hudOverlay: false",
        "",
        "stale_lobby_preview_hud",
      ),
    }),
  },
  {
    name: "duplicate_reentry_layer",
    mutate: (candidate) => ({
      ...candidate,
      overlay: replaceRequired(
        candidate.overlay,
        /\s*if \(host\.__glasslineHud && typeof host\.__glasslineHud\.dispose === "function"\) \{\s*host\.__glasslineHud\.dispose\(\);\s*\}/,
        "",
        "duplicate_reentry_layer",
      ),
    }),
  },
  {
    name: "stale_debug_handle",
    mutate: (candidate) => ({
      ...candidate,
      overlay: replaceRequired(
        candidate.overlay,
        /\s*if \(typeof window !== "undefined" && window\.__glasslineAirportHud === handle\) \{\s*delete window\.__glasslineAirportHud;\s*\}/,
        "",
        "stale_debug_handle",
      ),
    }),
  },
  {
    name: "compact_tier_removed",
    mutate: (candidate) => ({
      ...candidate,
      overlay: replaceRequired(candidate.overlay, "const COMPACT_LOD = 55;", "const COMPACT_LOD = 85;", "compact_tier_removed"),
    }),
  },
  {
    name: "detail_card_reintroduced",
    mutate: (candidate) => ({
      ...candidate,
      overlay: `import { createDetailCard } from "./glassline-detail-card.mjs";\n${candidate.overlay}`,
    }),
  },
  {
    name: "legacy_manifest_cards_visible",
    mutate: (candidate) => ({
      ...candidate,
      overlay: replaceRequired(
        candidate.overlay,
        "manifestCardLayer.visible = false;",
        "",
        "legacy_manifest_cards_visible",
      ),
    }),
  },
];

assertContract(sources);
for (const redCase of redCases) {
  assert.throws(
    () => assertContract(redCase.mutate(sources)),
    undefined,
    `controlled RED must fail: ${redCase.name}`,
  );
}

console.log(JSON.stringify({
  result: "PASS",
  visible_identity_tiers: ["compact"],
  hidden_states: ["distance", "offscreen", "overlap"],
  detail_card_dom: false,
  legacy_manifest_cards_visible: false,
  owned_disposal_paths: 2,
  controlled_red_cases: redCases.map(({ name }) => name),
}, null, 2));
