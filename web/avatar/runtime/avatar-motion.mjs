const engineFile = "../animation/drivers/humanoid/avatar-motion.mjs"; export const { AvatarMotion } = await import(new URL(engineFile, import.meta.resolve("#scene-manager")).href);
