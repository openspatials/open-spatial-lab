/** Host acquisition of the already bundled backend. No vendor browser or clock is created. */
export async function loadOwnX3dAmmo({ signal, assetUrl, documentTarget, importModule = url => import(url) }) {
  signal.throwIfAborted();
  const { default: X3D } = await importModule(assetUrl("/vendor/scene-core/vendor/x_ite/x_ite.min.mjs"));
  signal.throwIfAborted();
  if (!X3D.Namespace.AmmoClass) {
    await new Promise((resolve, reject) => {
      const script = documentTarget.createElement("script");
      const finish = error => {
        script.onload = script.onerror = null;
        signal.removeEventListener("abort", abort);
        script.remove();
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(signal.reason || new DOMException("Ammo preparation retired", "AbortError"));
      script.src = assetUrl("/vendor/scene-core/vendor/x_ite/assets/components/RigidBodyPhysicsComponent.min.js");
      script.onload = () => finish();
      script.onerror = () => finish(new Error("Bundled soft-body component did not load"));
      signal.addEventListener("abort", abort, { once: true });
      try { documentTarget.head.appendChild(script); } catch (error) { finish(error); }
    });
  }
  signal.throwIfAborted();
  const Ammo = X3D.Namespace.AmmoClass;
  if (!Ammo?.btSoftRigidDynamicsWorld) throw new Error("Bundled Ammo has no soft-body world");
  return { Ammo };
}
