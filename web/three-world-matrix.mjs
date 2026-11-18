// three.js 0.186 recomputes a world matrix in updateWorldMatrix() only when that object's matrixWorldNeedsUpdate is set
// (or force is passed to that one object), and a recomputed parent is not passed on to the chain below it. A node the
// lab places with matrixAutoUpdate = false then keeps a stale world matrix, for example the portals of a portal window
// once its root has been moved into place. refreshWorldMatrix brings one object's world matrix up to date from the
// scene root down, as updateWorldMatrix(true, false) did up to r160. It leaves matrixWorldNeedsUpdate as it is, so the
// next render still updates the rest of the scene.
export function refreshWorldMatrix(object) {
  const chain = [];
  for (let node = object; node; node = node.parent) chain.push(node);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i];
    if (node.matrixAutoUpdate) node.updateMatrix();
    if (node.parent) node.matrixWorld.multiplyMatrices(node.parent.matrixWorld, node.matrix);
    else node.matrixWorld.copy(node.matrix);
  }
  return object.matrixWorld;
}
