// The lab's canonical room through the render boundary, for the X3D renderers. After Nicholas Polys's adapter form
// of mountCanonicalWorldContent in npolys/open-spatial-lab (commit 99175b4b6, Apache-2.0). That file was not among
// the fetched ones, so this is written from how his x3dom-portal-traversal-glue.mjs calls it. The three.js path keeps
// its own builder, canonical-world-content.js, which holds the same numbers.
//
// `world.omitLights` leaves the lights out. X3DOM's lights reach the whole document.
import { LEGACY_WORLD_PRESENTATION } from "../canonical-world-content.js";

export function mountCanonicalWorldLights(adapter, parent) {
  const ambient = adapter.createAmbientLight({ color: 0xffffff, intensity: 0.75 });
  adapter.setName(ambient, "canonical-world-ambient");
  adapter.add(parent, ambient);
  const key = adapter.createDirectionalLight({ color: 0xffffff, intensity: 0.9, position: [4, 8, 6] });
  adapter.setName(key, "canonical-world-key");
  adapter.add(parent, key);
}

export function mountCanonicalWorldContent(adapter, parent, world) {
  const roomColor = adapter.createColor(world?.color || "#3aa0ff");
  if (!world?.omitLights) mountCanonicalWorldLights(adapter, parent);

  const floorColor = adapter.multiplyColorScalar(roomColor, 0.35);
  const floor = adapter.createMesh(
    adapter.createGeometry({ type: "plane", width: 12, height: 12 }),
    adapter.createMaterial({ type: "standard", color: floorColor, roughness: 0.95, side: "double" }),
  );
  adapter.setName(floor, "canonical-world-floor");
  adapter.setRotationAxis(floor, "x", -Math.PI / 2);
  adapter.add(parent, floor);

  const grid = adapter.createGridHelper({
    size: 12, divisions: 12, colorCenterLine: 0xffffff, colorGrid: 0x88aacc, transparent: true, opacity: 0.28,
  });
  adapter.setName(grid, LEGACY_WORLD_PRESENTATION.productGridName);
  adapter.setPosition(grid, 0, 0.01, 0);
  adapter.add(parent, grid);

  const wallColor = adapter.multiplyColorScalar(roomColor, 0.55);
  const wallMaterial = () => adapter.createMaterial({ type: "standard", color: wallColor, roughness: 0.9, side: "double" });
  const backWall = adapter.createMesh(adapter.createGeometry({ type: "plane", width: 12, height: 5 }), wallMaterial());
  adapter.setName(backWall, "canonical-world-wall-z");
  adapter.setPosition(backWall, 0, 2.5, -6);
  adapter.add(parent, backWall);
  const leftWall = adapter.createMesh(adapter.createGeometry({ type: "plane", width: 12, height: 5 }), wallMaterial());
  adapter.setName(leftWall, "canonical-world-wall-x");
  adapter.setRotationAxis(leftWall, "y", Math.PI / 2);
  adapter.setPosition(leftWall, -6, 2.5, 0);
  adapter.add(parent, leftWall);

  return {
    source: "shared_canonical_legacy_world_builder",
    world_color: `#${adapter.colorToHexString(roomColor)}`,
    floor_color: `#${adapter.colorToHexString(floorColor)}`,
    wall_color: `#${adapter.colorToHexString(wallColor)}`,
    semantic_inventory: ["canonical-world-floor", LEGACY_WORLD_PRESENTATION.productGridName, "canonical-world-wall-z", "canonical-world-wall-x"],
    presentation_policy: LEGACY_WORLD_PRESENTATION.authority,
    product_grid_name: LEGACY_WORLD_PRESENTATION.productGridName,
    debug_grid_included: true,
  };
}
