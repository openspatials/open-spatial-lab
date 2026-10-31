// The contract a humanoid avatar source meets in the X3D boot path.
//
// Nicholas Polys's fork npolys/open-spatial-lab (commit 99175b4b6) has a file of this name. It was
// not among the fetched files, so this one is written from the way web/x3dom-gltf-humanoid-provider.mjs
// (his) uses it: the same methods, under his names.
export class HumanoidProvider {
  constructor() {
    if (new.target === HumanoidProvider) throw new Error("HumanoidProvider is an interface; instantiate a concrete provider");
  }
  get kind() { throw new Error("not implemented"); }
  /** Returns { handle, ready }. handle exists at once; ready resolves when the avatar has loaded. */
  spawnAvatar({ url, position }) { throw new Error("not implemented"); }
  setPosition(handle, x, y, z) { throw new Error("not implemented"); }
  setRotation(handle, yawRadians) { throw new Error("not implemented"); }
  setVisible(handle, visible) { throw new Error("not implemented"); }
  dispose(handle) { throw new Error("not implemented"); }
  /** Returns { itemHandle, ready }. */
  attachItem(avatarHandle, { url, localTransform, attachmentPoint } = {}) { throw new Error("not implemented"); }
  detachItem(itemHandle) { throw new Error("not implemented"); }
}
