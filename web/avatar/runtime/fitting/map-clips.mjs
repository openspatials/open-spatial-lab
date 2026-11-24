const engineFile = "../process/clips/map-clips.mjs"; export const { buildRigMap, mapClip, mapPoseAt } = await import(new URL(engineFile, import.meta.resolve("#scene-manager")).href);
