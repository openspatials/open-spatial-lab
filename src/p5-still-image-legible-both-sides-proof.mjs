#!/usr/bin/env node
/**
 * P5 — FAR-AWAY STILL-IMAGE LAYER, LEGIBLE ON BOTH SIDES
 *  — deterministic proof.
 *
 * P4 already proved (17/17) that OUTSIDE the portal's circled perimeter the
 * live spatial render is refused and the aperture falls to the 2D IMAGE rungs
 * (portalPerimeterLiveGate.live === false / surfaceForPortal ->
 * outside_portal_perimeter). P5 makes that still image LEGIBLE on BOTH faces of
 * the portal — the DoubleSide aperture used to show the back face mirrored
 * (text backwards, the screenshot). This proof pins, against the
 * SHIPPING modules (no lookalike logic):
 *
 *  SECTION 1 — the pure per-face legibility rule (imageLayerFlipForViewerSide,
 *  the exported shipping helper):
 *   - null/unknown viewer side defaults to the FRONT identity (pre-P5 preserved).
 *   - front -> identity UV transform (repeat_x 1 / offset_x 0);
 *     back  -> horizontal mirror (repeat_x -1 / offset_x 1  =>  u' = 1 - u).
 *   - the numbers actually produce that transform in three.js's OWN uv-matrix
 *     math (a real THREE.Texture: front matrix maps u->u, back maps u->1-u).
 *
 *  SECTION 2 — both-sides legibility, composed against the REAL aperture
 *  geometry: the app's standing-oval aperture is a THREE.CircleGeometry whose
 *  normals face local +Z (= the frame FRONT) and whose uv.x increases with
 *  local +X (asserted from the real geometry buffer). A DoubleSide plane's back
 *  face negates the screen-horizontal, so the back face geometrically mirrors
 *  (g_back(s) = 1 - s) while the front face does not (g_front(s) = s). Composing
 *  the SHIPPED flip output with that geometry:
 *   - front viewer + front face + front flip  -> content(s) = s  (legible; the
 *     preserved baseline).
 *   - back  viewer + back  face + back  flip  -> content(s) = s  (LEGIBLE —
 *     mirror ∘ mirror = identity).
 *   - ORACLE TOOTH: back face with NO flip (the pre-P5 defect / any revert that
 *     drops the flip) -> content(s) = 1 - s  (MIRRORED). A revert cannot pass.
 *
 *  SECTION 3 — tie to P4's perimeter gate + the REAL preview manager: a warm
 *  machine whose zone.inside is false (outside the circle) is NOT live
 *  (portalPerimeterLiveGate) and NOT renderable (machineRenderable), and the
 *  REAL SpatialPortalPreviewManager.surfaceForPortal refuses
 *  `outside_portal_perimeter` for a camera placed outside on the FRONT AND on
 *  the BACK — so the 2D still-image layer (with the P5 flip) is what owns the
 *  aperture on both faces; for each face the shipped flip yields the legible
 *  orientation.
 *
 *  SECTION 4 — source wiring (honest, like P4's E1i): app.js imports the helper,
 *  calls the flip on the primary AND additional 2D-rung textures keyed on the
 *  viewer side, sets the data-portal-image-* page-truth attributes, and never
 *  flips the spatial/child-fabric rungs; the helper carries its
 *  *_standard_conformance:false label.
 *
 * No servers, no ports (the perimeter gate is proven from real machine
 * projections + the real manager — the server-backed freshness/TTL teeth are
 * P4's). Never touches 8143/18151-18154. Claim boundary: local application-level
 * proof; image legibility carries image_legibility_standard_conformance:false;
 * no TeleportXR/production/standards claim.
 */

import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  fabricPortalKey,
  normalizePortalTraversal,
  portalFrameForLocation,
} from "../web/live-adapter-portal-geometry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**  loader recipe (P4 precedent): load the SHIPPING preview module in node
 *  by rewriting only the browser THREE import specifier to node_modules/three. */
async function loadPreviewModule() {
  const modulePath = resolve(repoRoot, "web/portal-spatial-preview.mjs");
  const threeUrl = pathToFileURL(resolve(repoRoot, "node_modules/three/build/three.module.js")).href;
  const browserThreeImport = 'import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";';
  const tempRoot = await mkdtemp(resolve(tmpdir(), "runtime-p5-image-"));
  let source = await readFile(modulePath, "utf8");
  if (!source.includes(browserThreeImport)) {
    throw new Error("production Three.js import seam not found in portal-spatial-preview.mjs");
  }
  source = source.replace(browserThreeImport, `import * as THREE from ${JSON.stringify(threeUrl)};`);
  const tempModulePath = resolve(tempRoot, "portal-spatial-preview-production.mjs");
  await writeFile(tempModulePath, source);
  await copyFile(
    resolve(repoRoot, "web/live-adapter-portal-geometry.mjs"),
    resolve(tempRoot, "live-adapter-portal-geometry.mjs"),
  );
  const mod = await import(pathToFileURL(tempModulePath).href);
  const THREE = await import(threeUrl);
  return { mod, THREE, cleanup: () => rm(tempRoot, { recursive: true, force: true }) };
}

let passed = 0;
let failed = 0;
const results = [];
async function check(id, desc, fn) {
  try {
    await fn();
    passed += 1;
    results.push({ id, desc, status: "PASS" });
    console.log(`PASS  ${id}  ${desc}`);
  } catch (err) {
    failed += 1;
    results.push({ id, desc, status: "FAIL", error: err.message });
    console.log(`FAIL  ${id}  ${desc}  -> ${err.message}`);
  }
}
function assertOk(cond, msg) {
  if (!cond) throw new Error(msg);
}
function close(a, b, tol, label) {
  assertOk(Math.abs(a - b) <= tol, `${label}: |${a} - ${b}| > ${tol}`);
}

/** Avatar/camera position on the given side of a portal frame at planar
 *  distance d (P4 recipe). */
function positionOnSide(frame, side, distanceM, lateralM = 0) {
  const sgn = side === "back" ? -1 : 1;
  return [
    frame.position[0] + frame.forward[0] * sgn * distanceM + frame.right[0] * lateralM,
    0,
    frame.position[2] + frame.forward[2] * sgn * distanceM + frame.right[2] * lateralM,
  ];
}

async function main() {
  const diagnostics = {
    wo: "runtime",
    title: "far-away still-image layer, flipped legible on both sides (issue 3)",
    started_at: new Date().toISOString(),
    claim_boundary:
      "local application-level validation; image legibility carries " +
      "image_legibility_standard_conformance:false; no TeleportXR/production/standards claim",
    checks: null,
  };

  const { mod: preview, THREE, cleanup } = await loadPreviewModule();
  const {
    imageLayerFlipForViewerSide,
    portalPerimeterLiveGate,
    portalViewerSide,
    SpatialPortalPreviewManager,
  } = preview;

  try {
    // ================= SECTION 1 — the pure legibility rule ================
    await check("L0", "imageLayerFlipForViewerSide is exported and defaults null/unknown side to the FRONT identity (pre-P5 preserved)", () => {
      assertOk(typeof imageLayerFlipForViewerSide === "function", "helper not exported");
      for (const side of [null, undefined, "sideways", {}, { side: "unknown" }]) {
        const f = imageLayerFlipForViewerSide(side);
        assertOk(f.mirrored === false && f.repeat_x === 1 && f.offset_x === 0,
          `unknown side ${JSON.stringify(side)} did not default to identity: ${JSON.stringify(f)}`);
      }
      const f = imageLayerFlipForViewerSide(null);
      assertOk(f.validation && f.validation.image_legibility_standard_conformance === false && f.validation.application_level === true,
        "missing the application-level non-conformance label");
    });

    await check("L1", "front -> identity UV transform; back -> horizontal mirror (repeat_x -1 / offset_x 1)", () => {
      for (const front of ["front", { side: "front" }]) {
        const f = imageLayerFlipForViewerSide(front);
        assertOk(f.viewer_side === "front" && f.mirrored === false && f.repeat_x === 1 && f.offset_x === 0,
          `front flip wrong: ${JSON.stringify(f)}`);
      }
      for (const back of ["back", { side: "back" }]) {
        const f = imageLayerFlipForViewerSide(back);
        assertOk(f.viewer_side === "back" && f.mirrored === true && f.repeat_x === -1 && f.offset_x === 1,
          `back flip wrong: ${JSON.stringify(f)}`);
      }
    });

    await check("L2", "the shipped numbers produce u->u (front) and u->1-u (back) in three.js's OWN uv-transform matrix", () => {
      const uvTransform = (flip, u, v) => {
        const tex = new THREE.Texture();
        tex.repeat.x = flip.repeat_x;
        tex.offset.x = flip.offset_x;
        tex.updateMatrix();
        const p = new THREE.Vector3(u, v, 1).applyMatrix3(tex.matrix);
        return { u: p.x, v: p.y };
      };
      const front = imageLayerFlipForViewerSide("front");
      const back = imageLayerFlipForViewerSide("back");
      for (const [u, v] of [[0, 0], [0.25, 0.3], [0.5, 0.5], [0.8, 0.9], [1, 1]]) {
        const fr = uvTransform(front, u, v);
        close(fr.u, u, 1e-9, `front sampled u at ${u}`);
        close(fr.v, v, 1e-9, `front sampled v at ${v} (vertical must be untouched)`);
        const bk = uvTransform(back, u, v);
        close(bk.u, 1 - u, 1e-9, `back sampled u at ${u} (expected horizontal mirror 1-u)`);
        close(bk.v, v, 1e-9, `back sampled v at ${v} (vertical must be untouched)`);
      }
    });

    // ================= SECTION 2 — both-sides legibility vs REAL geometry ===
    // The app's standing-oval aperture: THREE.CircleGeometry(0.92, 72), material
    // THREE.DoubleSide (web/app.js buildDirectionalPortal). Read the real buffer.
    let uvIncreasesWithPlusX = false;
    await check("L3", "REAL aperture CircleGeometry: normals face local +Z (frame front) and uv.x increases with local +X", () => {
      const geo = new THREE.CircleGeometry(0.92, 72);
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      const nrm = geo.attributes.normal;
      assertOk(pos && uv && nrm, "CircleGeometry missing position/uv/normal attributes");
      let maxXi = -1;
      let minXi = -1;
      for (let i = 0; i < pos.count; i += 1) {
        // every face normal points along local +Z (the aperture faces frame-front)
        close(nrm.getZ(i), 1, 1e-6, `vertex ${i} normal.z`);
        if (maxXi < 0 || pos.getX(i) > pos.getX(maxXi)) maxXi = i;
        if (minXi < 0 || pos.getX(i) < pos.getX(minXi)) minXi = i;
      }
      // rim vertex at local +X (right on the front view) has the larger uv.x
      uvIncreasesWithPlusX = uv.getX(maxXi) > uv.getX(minXi);
      assertOk(uvIncreasesWithPlusX,
        `uv.x does not increase with +X: uv@maxX=${uv.getX(maxXi)} uv@minX=${uv.getX(minXi)}`);
      close(uv.getX(maxXi), 1, 1e-6, "uv.x at local +X rim");
      close(uv.getX(minXi), 0, 1e-6, "uv.x at local -X rim");
      geo.dispose();
    });

    await check("L4", "BOTH SIDES LEGIBLE: composing the SHIPPED flip with the DoubleSide geometry mirror maps screen->canvas as identity on each viewed face; a revert that drops the flip leaves the back MIRRORED", () => {
      assertOk(uvIncreasesWithPlusX, "L3 precondition (uv orientation) not established");
      // Geometry mapping screen-horizontal s in [0,1] (left->right as the viewer
      // sees it) to geometry-uv. uv.x increases with local +X (L3). The front
      // face shows local +X on the right (g_front(s) = s); a DoubleSide back
      // face negates the screen-horizontal, so it shows local +X on the left
      // (g_back(s) = 1 - s).
      const gFront = (s) => s;
      const gBack = (s) => 1 - s;
      // The shader samples canvas-content-u = uv * repeat_x + offset_x (three's
      // uv transform, proven in L2). Legible <=> content(s) == s (left screen
      // shows left canvas content), i.e. an increasing 1:1 mapping.
      const T = (flip, g) => g * flip.repeat_x + flip.offset_x;
      const front = imageLayerFlipForViewerSide("front");
      const back = imageLayerFlipForViewerSide("back");
      const samples = [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1];
      for (const s of samples) {
        // front viewer looks at the front face with the front flip
        close(T(front, gFront(s)), s, 1e-9, `front face content at screen ${s} (baseline legible)`);
        // back viewer looks at the back face with the back flip -> mirror∘mirror
        close(T(back, gBack(s)), s, 1e-9, `back face content at screen ${s} (P5 legible)`);
      }
      // ORACLE TOOTH: the pre-P5 defect (and any revert that drops the flip) is
      // the FRONT flip applied on the back face -> content(s) = 1 - s (mirrored).
      let mirroredWitnessed = false;
      for (const s of samples) {
        const content = T(front, gBack(s)); // no back flip == the defect
        if (Math.abs(content - s) > 1e-6) mirroredWitnessed = true;
        close(content, 1 - s, 1e-9, `defect content at screen ${s} must be the mirror 1-s`);
      }
      assertOk(mirroredWitnessed,
        "REVERT NOT DETECTED: dropping the back flip did not mirror the back face — the oracle is blind");
      diagnostics.legibility = {
        front_face_baseline: "content(s) = s (identity, unchanged from pre-P5)",
        back_face_p5: "content(s) = s (back geometry mirror cancelled by the u->1-u texture flip)",
        defect_without_flip: "content(s) = 1 - s (back face reads mirrored — the reported screenshot)",
      };
    });

    // ================= SECTION 3 — tie to P4's perimeter gate + manager ======
    // A realistic warm machine with a real prefetch zone; flip zone.inside to
    // model walking outside the circle.
    const radius = 6;
    const hysteresis = 1.15;
    const exitRadius = radius * hysteresis;
    const region = {
      entities: [{ object_id: "e0", position: [10, 0, -2], color: "#8fd0ff", shape: "box", size_m: 0.6 }],
      avatars: { avatars: [], circle: { center: [10, 0, 0], radius_m: 5 } },
      region: { center: [10, 0, 0], radius_m: 5 },
      destination_portal: { trigger_position: [10, 0, 0], trigger_radius_m: 1.25 },
    };
    const warmInside = {
      supported: true,
      status: "warm",
      target_location_id: "location-a",
      zones: { prefetch: { radius_m: radius, hysteresis_ratio: hysteresis } },
      zone: { inside: true, distance_m: 1.2 },
      region,
    };
    const warmOutside = { ...warmInside, zone: { inside: false, distance_m: exitRadius + 1 } };

    await check("L5", "runtime override: outside closes region subscription truth but canonical rendering remains eligible", () => {
      const gIn = portalPerimeterLiveGate(warmInside);
      const gOut = portalPerimeterLiveGate(warmOutside);
      assertOk(gIn.live === true && gIn.reason === "inside_portal_perimeter", JSON.stringify(gIn));
      assertOk(gOut.live === false && gOut.reason === "outside_portal_perimeter", JSON.stringify(gOut));
      assertOk(SpatialPortalPreviewManager.machineRenderable(warmInside) === true, "inside must be renderable (live window)");
      assertOk(SpatialPortalPreviewManager.machineRenderable(warmOutside) === true,
        "outside perimeter incorrectly forced the still-image layer back into ownership");
    });

    // Build a real portal entry (frame + adopted target frame + bidirectional
    // traversal) with the shipping geometry helper.
    const frame = portalFrameForLocation({
      portalId: "lobby-portal-a",
      locationId: "location-lobby",
      triggerPosition: [0, 0, 0],
      triggerRadius: 1.25,
      targetLocationId: "location-a",
    });
    const targetFrame = {
      ...portalFrameForLocation({
        portalId: "location-a-portal-lobby",
        locationId: "location-a",
        triggerPosition: [10, 0, 0],
        triggerRadius: 1.25,
        targetLocationId: "location-lobby",
      }),
      pose_source: "destination_region_portal_pose",
    };
    const entry = {
      string_portal_id: "lobby-portal-a",
      source_location_id: "location-lobby",
      target_location_id: "location-a",
      frame,
      target_frame: targetFrame,
      traversal: normalizePortalTraversal({ mode: "bidirectional" }),
    };
    const key = fabricPortalKey(entry);

    const stubRenderer = {
      localClippingEnabled: false,
      getSize: (v) => v.set(1280, 800),
      getRenderTarget: () => null,
      setRenderTarget() {},
      clear() {},
      render() {},
      readRenderTargetPixels() { throw new Error("no GPU in this harness"); },
    };
    const mainCamera = new THREE.PerspectiveCamera(60, 1280 / 800, 0.05, 80);
    const manager = new SpatialPortalPreviewManager({
      nowMs: () => Date.now(),
      resolveDestinationContent: async () => ({
        kind: "legacy_world",
        revision: "p5-validation",
        world: { location_id: "location-a", color: "#3aa0ff" },
      }),
      composeDestinationContent: () => {
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        mesh.position.set(10, 0.5, 1);
        mesh.name = "canonical-p5-validation-object";
        scene.add(mesh);
        return { scene, source: "p5-validation-canonical", semantic_inventory: [mesh.name] };
      },
    });
    manager.bindScene(stubRenderer, mainCamera, new THREE.Scene());
    const placeCamera = (side, distanceM) => {
      const p = positionOnSide(entry.frame, side, distanceM);
      mainCamera.position.set(p[0], 1.5, p[2]);
      mainCamera.lookAt(entry.frame.position[0], entry.frame.position[1], entry.frame.position[2]);
      mainCamera.updateMatrixWorld(true);
    };

    await check("L6", "REAL manager: OUTSIDE the perimeter the canonical spatial window owns BOTH faces; no still-image substitution", async () => {
      const outcomes = {};
      for (const side of ["front", "back"]) {
        placeCamera(side, exitRadius + 1);
        const camPos = [mainCamera.position.x, mainCamera.position.y, mainCamera.position.z];
        const surface = manager.surfaceForPortal(key, warmOutside, entry);
        assertOk(surface && surface.record,
          `${side}: canonical spatial window was refused outside the subscription perimeter`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        manager.renderActive();
        assertOk(surface.record.contentStatus === "ready", `${side}: canonical content did not settle`);
        // The legacy image helper remains correct if used for an ineligible
        // surface, but it is not the owner of this visible eligible portal.
        const viewerSide = portalViewerSide(camPos, entry);
        const flip = imageLayerFlipForViewerSide(viewerSide);
        assertOk(viewerSide && viewerSide.side === side, `${side}: viewer side classified as ${viewerSide && viewerSide.side}`);
        if (side === "front") assertOk(flip.mirrored === false && flip.repeat_x === 1, `front flip ${JSON.stringify(flip)}`);
        if (side === "back") assertOk(flip.mirrored === true && flip.repeat_x === -1, `back flip ${JSON.stringify(flip)}`);
        outcomes[side] = {
          canonical_surface: true,
          surface_reason: manager.lastSurfaceAttempt.reason,
          legacy_image_flip_inactive: flip,
        };
      }
      // and INSIDE, the live window DOES own the front aperture (image layer yields)
      placeCamera("front", radius - 1);
      const live = manager.surfaceForPortal(key, warmInside, entry);
      assertOk(live && live.record, `inside front: live window refused: ${JSON.stringify(manager.lastSurfaceAttempt)}`);
      diagnostics.perimeter_tie = {
        outside_front_canonical: outcomes.front,
        outside_back_canonical: outcomes.back,
        inside_front_live: !!(live && live.record),
      };
    });

    // ================= SECTION 4 — source wiring =============================
    await check("L7", "source wiring: app.js flips ONLY the 2D-rung textures keyed on viewer side (primary + additional), sets the page-truth attributes, and never flips the spatial/child rungs", async () => {
      const appSrc = await readFile(resolve(repoRoot, "web/app.js"), "utf8");
      const pspSrc = await readFile(resolve(repoRoot, "web/portal-spatial-preview.mjs"), "utf8");
      assertOk(/import\s*\{[^}]*imageLayerFlipForViewerSide[^}]*\}\s*from\s*["']\.\/portal-spatial-preview\.mjs/s.test(appSrc),
        "app.js does not import imageLayerFlipForViewerSide from the preview module");
      assertOk(/function\s+applyPortalImageLayerFlip\s*\(/.test(appSrc),
        "app.js does not define applyPortalImageLayerFlip");
      // exactly the two 2D-rung call sites (primary bundle.texture + additional rec.previewTexture)
      const callSites = appSrc.match(/applyPortalImageLayerFlip\s*\(/g) || [];
      assertOk(callSites.length === 3,
        `expected 1 definition + 2 call sites of applyPortalImageLayerFlip, found ${callSites.length}`);
      assertOk(/applyPortalImageLayerFlip\(bundle\.texture,\s*primaryViewerSide\)/.test(appSrc),
        "primary 2D rung does not flip bundle.texture keyed on primaryViewerSide");
      assertOk(/applyPortalImageLayerFlip\(rec\.previewTexture,\s*viewerSide\)/.test(appSrc),
        "additional 2D rung does not flip rec.previewTexture keyed on viewerSide");
      // page-truth attributes for the headed battery
      for (const attr of ["data-portal-image-layer-active", "data-portal-image-flip", "data-portal-image-legible"]) {
        assertOk(appSrc.includes(attr), `missing body attribute ${attr}`);
      }
      // the spatial + child rungs are marked image-layer inactive (not flipped)
      assertOk((appSrc.match(/data-portal-image-layer-active",\s*"false"/g) || []).length >= 2,
        "the spatial/child rungs do not mark the image layer inactive");
      // the helper carries its non-conformance label in the shipping module
      assertOk(/export function imageLayerFlipForViewerSide/.test(pspSrc),
        "portal-spatial-preview.mjs does not export imageLayerFlipForViewerSide");
      assertOk(/image_legibility_standard_conformance:\s*false/.test(pspSrc),
        "the shipped helper is missing image_legibility_standard_conformance:false");
    });

    diagnostics.finished_at = new Date().toISOString();
  } finally {
    await cleanup();
  }

  diagnostics.checks = results;
  diagnostics.passed = passed;
  diagnostics.failed = failed;
  const evidenceDir = resolve(repoRoot, "diagnostics");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    resolve(evidenceDir, "runtime-p5-still-image-legible-both-sides.json"),
    `${JSON.stringify(diagnostics, null, 2)}\n`,
  );
  console.log(`\n${passed}/${passed + failed} PASS -> diagnostics/p5-still-image-legible-both-sides.json`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("validation harness failed:", err);
  process.exit(1);
});
