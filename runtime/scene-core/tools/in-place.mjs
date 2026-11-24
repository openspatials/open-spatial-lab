// in-place.mjs: the build's clip clean-up (no root forward track, no scale tracks), so the module's tools do not need
// the mannequin's web folder.
import * as THREE from 'three';

export function makeInPlace(clip, name = clip.name) {
  const tracks = clip.tracks.filter((t) => t.name !== 'root.position' && !t.name.endsWith('.scale')).map((t) => t.clone());
  return new THREE.AnimationClip(name, clip.duration, tracks);
}
