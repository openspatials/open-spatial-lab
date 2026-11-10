/** Three.js presentation of plain world/preview descriptions. */
import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";
export const CHILD_FABRIC_LAYER = 2;

export function hexColorFromFabricBackground(background, fallback = 0x0b1020) {
  if (typeof background !== "string" || !/^[0-9a-fA-F]{6}$/.test(background)) return fallback;
  return parseInt(background, 16);
}

export function setLayerRecursive(object3d, layer) {
  object3d.layers.set(layer);
  object3d.traverse((child) => child.layers.set(layer));
}

export function makeFabricLabelSprite(lines, accentCss) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(8, 12, 26, 0.78)";
  ctx.strokeStyle = accentCss;
  ctx.lineWidth = 10;
  ctx.roundRect(10, 10, canvas.width - 20, canvas.height - 20, 30);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 64px ui-monospace, Menlo, monospace";
  ctx.fillText(String(lines[0] || ""), canvas.width / 2, 86);
  ctx.font = "38px ui-monospace, Menlo, monospace";
  ctx.fillStyle = accentCss;
  ctx.fillText(String(lines[1] || ""), canvas.width / 2, 172);
  const texture = new THREE.CanvasTexture(canvas);
  if ("SRGBColorSpace" in THREE) texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  );
  sprite.scale.set(2.6, 0.65, 1);
  return sprite;
}

export function buildChildFabricGroup(manifest, opts = {}) {
  const accent = opts.accent ?? 0xff7a3a;
  const accentFill = opts.accentFill ?? 0xffb14d;
  const group = new THREE.Group();
  group.name = `fabric-child-${(manifest && manifest.container) || "unknown"}`;
  group.userData.fabric = {
    container: manifest && manifest.container,
    url: opts.url || null,
    attached_at_portal_node: opts.attachedAtNodeId || null,
    unsigned_plain_json: true,
  };

  const roomColor = new THREE.Color(accent).multiplyScalar(0.35);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({ color: roomColor, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.name = "child-fabric-floor";
  group.add(floor);
  const grid = new THREE.GridHelper(12, 12, 0xffffff, 0xd88f5a);
  grid.material.opacity = 0.3;
  grid.material.transparent = true;
  group.add(grid);
  const wallMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent).multiplyScalar(0.55),
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), wallMat);
  backWall.position.set(0, 2.5, -6);
  group.add(backWall);
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-6, 2.5, 0);
  group.add(leftWall);

  group.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(4, 8, 6);
  group.add(key);

  const nodes =
    manifest && manifest.data && Array.isArray(manifest.data.Children) ? manifest.data.Children : [];
  for (const node of nodes) {
    if (!node) continue;
    const p = node.Transform && Array.isArray(node.Transform.Position)
      ? node.Transform.Position
      : [0, 0, 0];
    const px = Number(p[0]) || 0;
    const pz = Number(p[2]) || 0;
    const isPortalNode = node.Type && Number(node.Type.bSubtype) === 255;
    const ref = node.Resource && typeof node.Resource.sReference === "string" ? node.Resource.sReference : "";
    if (isPortalNode) {
      const portal = new THREE.Group();
      portal.name = `child-fabric-node-${(node.Head && node.Head.Self) || "portal"}`;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.075, 18, 80),
        new THREE.MeshStandardMaterial({
          color: accent,
          emissive: accent,
          emissiveIntensity: 0.7,
          roughness: 0.35,
          metalness: 0.25,
        })
      );
      portal.add(ring);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.92, 72),
        new THREE.MeshBasicMaterial({ color: accentFill, transparent: true, opacity: 0.2, side: THREE.DoubleSide })
      );
      portal.add(disc);
      portal.position.set(px, 1.35, pz);
      // stand the oval facing back into this child world's room (toward its spawn)
      portal.rotation.y = opts.portalYaw ?? 0;
      portal.scale.set(0.9, 1.4, 1);
      portal.visible = opts.suppressReturnPortal !== true;
      portal.userData.secondaryRingSuppressed = opts.suppressReturnPortal === true;
      group.add(portal);
    } else if (ref.startsWith("action:")) {
      continue;
    } else if (node.Transform) {
      const pad = new THREE.Group();
      pad.name = `child-fabric-node-${(node.Head && node.Head.Self) || "spawn"}`;
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 0.06, 40),
        new THREE.MeshStandardMaterial({ color: accentFill, emissive: accent, emissiveIntensity: 0.35 })
      );
      disc.position.y = 0.03;
      pad.add(disc);
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 1.5, 10),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })
      );
      post.position.y = 0.78;
      pad.add(post);
      pad.position.set(px, 0, pz);
      group.add(pad);
    }
  }

  const label = makeFabricLabelSprite(
    [
      String((manifest && manifest.container) || "child fabric").toUpperCase(),
      "child fabric · plain-JSON (unsigned)",
    ],
    opts.accentCss || "#ffb14d"
  );
  label.position.set(
    opts.labelPosition ? opts.labelPosition[0] : 0.8,
    2.35,
    opts.labelPosition ? opts.labelPosition[2] : -2.8
  );
  label.name = "child-fabric-container-label";
  group.add(label);

  setLayerRecursive(group, CHILD_FABRIC_LAYER);
  return group;
}

export function buildRootFabricNodeVisuals(impl, navigatorDebug) {
  if (!impl || !impl.scene || !navigatorDebug) return null;
  const stale = [];
  impl.scene.traverse((node) => {
    if (node?.name === "fabric-root-portal-trigger-node") stale.push(node);
  });
  for (const node of stale) {
    node.parent?.remove(node);
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((material) => material?.dispose?.());
  }
  if (impl.rootFabricNodesGroup?.parent) impl.rootFabricNodesGroup.parent.remove(impl.rootFabricNodesGroup);
  impl.rootFabricNodesGroup = null;
  return null;
}
