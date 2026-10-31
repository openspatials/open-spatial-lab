// The stage under an authored Web of Worlds graph, built through a RenderAdapter: floor, grid, lights
// and a framing camera pose. Used by the X3DOM portal preview of the airport.
//
// Nicholas Polys's fork ported all of web/wow-scene.mjs (buildWowScene) to the adapter. That file was
// not among the fetched ones, and the lab's wow-scene.mjs has moved on since his fork point and still
// builds with three.js. So this is a small stand-in with the part his glue uses: the call shape
// buildWowScene(graph, createAdapter, opts) and a returned camera pose. The default path keeps wow-scene.mjs.
export function buildWowScene(graph, createAdapter, opts = {}) {
  const adapter = createAdapter();
  const root = adapter.createGroup("wow-composition-root");
  adapter.add(adapter.sceneRoot, root);
  const floor = adapter.createMesh(
    adapter.createGeometry({ type: "plane", width: 24, height: 24 }),
    adapter.createMaterial({ type: "standard", color: 0x161d31, roughness: 0.95, metalness: 0.05, side: "double" }),
  );
  adapter.setRotationAxis(floor, "x", -Math.PI / 2);
  adapter.setName(floor, "wow-floor");
  adapter.add(root, floor);
  adapter.add(root, adapter.createGridHelper({ size: 24, divisions: 24, colorGrid: 0x263250, transparent: true, opacity: 0.4 }));
  // No lights: X3DOM's lights reach the whole document, so the main room's lights light this stage too.
  return { root, camera_pose: { position: [0, 3.2, 12], lookAt: [0, 1.4, 0] }, source: opts.source || "x3d_wow_graph_stage", graph_nodes: Object.keys(graph?.nodes || {}).length };
}
