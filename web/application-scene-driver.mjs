export function sceneDriver(readers, owners) {
  const { sceneRuntimeController, liveViewport, mainDemo } = owners;
  const { getScene, adapterVisualRuntimeSnapshot } = readers;
  return {
    scene: getScene(),
    rendererKind: getScene().rendererKind,
    evaluatedPoses: () => sceneRuntimeController.evaluatedPoses(),
    rendererCapabilities: () =>
      sceneRuntimeController.activeAdapter()?.getCapabilities(),
    viewport: {
      snapshot: liveViewport.snapshot,
      forceSync: () => liveViewport.resize({ force: true }),
      schedule: liveViewport.schedule,
      identity: () => {
        const impl = getScene() && getScene()._impl;
        const visual = adapterVisualRuntimeSnapshot();
        return {
          scene: getScene(),
          renderer: impl && impl.renderer,
          camera: impl && impl.camera,
          canvas:
            impl && (impl.renderer ? impl.renderer.domElement : impl.canvas),
          avatar: visual?.state?.avatar || null,
          world: visual?.world || null,
          portal: visual?.state?.portal || null,
        };
      },
    },
    cameraSpaceOfPoint: (p) => sceneRuntimeController.cameraSpaceOfPoint(p),
    liveAuthoredScene: () => sceneRuntimeController.liveAuthoredScene(),
    samplePortalApertureTexels: (portalKey, worldPoints) =>
      sceneRuntimeController.samplePortalApertureTexels(portalKey, worldPoints),
    portalPreviews: () => sceneRuntimeController.portalPreviewStates(),
    portalRefusals: () => mainDemo.refusals(),
  };
}
