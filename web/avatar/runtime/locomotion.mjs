const engineFile = "../navigation/humanoid/locomotion.mjs"; export const { createTuning, Locomotion } = await import(new URL(engineFile, import.meta.resolve("#scene-manager")).href);
