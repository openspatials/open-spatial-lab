/**
 * Canonical composition for the legacy A/B/lobby worlds.
 *
 * Direct views and bounded portal views call this same function. Product
 * presentation policy belongs here so callers cannot drift on visible layers.
 */
export const LEGACY_WORLD_PRESENTATION = Object.freeze({
  authority: "shared_canonical_legacy_world_presentation_v1",
  includeProductGrid: true,
  productGridName: "canonical-world-debug-grid",
});

import { describeScene } from "./scene-description.mjs";

export function mountCanonicalWorldContent(scene, THREE, world, { sceneDescription = describeScene({ world }) } = {}) {
  if (!scene || !THREE) throw new Error("canonical world content requires scene and THREE");
  const roomColor = new THREE.Color(world?.color || "#3aa0ff");

  for (const spec of sceneDescription.lighting.lights) {
    const light = spec.kind === "ambient" ? new THREE.AmbientLight(spec.color, spec.intensity) : new THREE.DirectionalLight(spec.color, spec.intensity);
    light.name = spec.name || "";
    if (spec.position) light.position.fromArray(spec.position);
    scene.add(light);
  }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({
      color: roomColor.clone().multiplyScalar(0.35),
      roughness: 0.95,
    }),
  );
  floor.name = "canonical-world-floor";
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  let grid = null;
  if (LEGACY_WORLD_PRESENTATION.includeProductGrid) {
    grid = new THREE.GridHelper(12, 12, 0xffffff, 0x88aacc);
    grid.name = LEGACY_WORLD_PRESENTATION.productGridName;
    grid.material.opacity = 0.28;
    grid.material.transparent = true;
    scene.add(grid);
  }

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: roomColor.clone().multiplyScalar(0.55),
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), wallMaterial);
  backWall.name = "canonical-world-wall-z";
  backWall.position.set(0, 2.5, -6);
  scene.add(backWall);
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), wallMaterial.clone());
  leftWall.name = "canonical-world-wall-x";
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-6, 2.5, 0);
  scene.add(leftWall);

  return {
    source: "shared_canonical_legacy_world_builder",
    world_color: `#${roomColor.getHexString()}`,
    floor_color: `#${floor.material.color.getHexString()}`,
    wall_color: `#${wallMaterial.color.getHexString()}`,
    semantic_inventory: [floor.name, grid.name, backWall.name, leftWall.name],
    presentation_policy: LEGACY_WORLD_PRESENTATION.authority,
    product_grid_name: grid.name,
    debug_grid_included: !!grid,
  };
}

export default { LEGACY_WORLD_PRESENTATION, mountCanonicalWorldContent };
