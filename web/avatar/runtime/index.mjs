// Public entry of the Lab avatar runtime 1.0.0 (see RELEASE.json). Re-exports only; no logic lives here.
// The modules are the vendor/avatar-evaluator-v1 copy the Lab page ran before 1.0.0, with only import paths changed.
// three.js is imported by bare specifier: 'three' and 'three/addons/' must resolve (import map or Node resolution).
// RemoteAvatar is not exported: the vendor copy has no remote-avatar module (RELEASE.json "surface_differences").
export { loadAvatarLibrary, createAvatarInstance } from './clip-library.mjs';
export { Locomotion, createTuning } from './locomotion.mjs';
export { Equipment, loadItemLibrary, canEquip, canHold } from './equipment.mjs';
export { AvatarMotion } from './avatar-motion.mjs';
