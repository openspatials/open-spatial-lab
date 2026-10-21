/**
 * scene.js — Lane 1 visual verifier.
 *
 * Primary path: a Three.js FALLBACK verifier (room + continuity avatar + portal
 * ring/threshold) with phase-driven departure/arrival visuals.
 *
 * Resilient degrade: if a WebGL context cannot be created (e.g. a headless CI
 * environment without a GPU), the scene transparently degrades to a Canvas2D
 * top-down depiction that renders the SAME four visual states. This keeps the
 * acceptance evidence (source-before / target-before / source-departure /
 * target-arrival) capturable everywhere, and — critically — the UI STATE
 * MACHINE never depends on a GL context.
 *
 * HARD LABEL either way: this is the FALLBACK verifier, NOT first-party
 * TeleportXR browser rendering. The renderer kind (webgl|canvas2d) is exposed
 * as `scene.rendererKind` and surfaced in the UI + evidence.
 */

import { HANDOFF_PHASES } from "./frontend-contract.js";
import { mountCanonicalWorldContent } from "./canonical-world-content.js";

export class Scene {
  constructor(mount, role, world) {
    this.mount = mount;
    this.role = role;
    this.world = world;
    this.phase = role === "source" ? HANDOFF_PHASES.IDLE : HANDOFF_PHASES.WAITING;
    this.avatar = role === "source"
      ? { position: (world.avatar && world.avatar.spawn_position) || [0, 0, 3.2], rotation_y: 0 }
      : null;
    this._t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.rendererKind = "none";

    let impl = null;
    try {
      impl = new WebGLScene(mount, role, world);
      this.rendererKind = "webgl";
    } catch (err) {
      console.warn(`[scene-runtime] WebGL unavailable, degrading to canvas2d fallback: ${err.message}`);
      impl = new Canvas2DScene(mount, role, world);
      this.rendererKind = "canvas2d";
    }
    this._impl = impl;
    this._impl.setPhase(this.phase);
    this._impl.setAvatar(this.avatar);
  }
  setPhase(phase) { this.phase = phase; this._impl.setPhase(phase); }
  setAvatar(avatar) { this.avatar = avatar; this._impl.setAvatar(avatar); }
  resize() { this._impl.resize && this._impl.resize(); }
  dispose() { this._impl.dispose && this._impl.dispose(); }
}

/* --------------------------- WebGL implementation --------------------------- */
class WebGLScene {
  constructor(mount, role, world) {
    // dynamic-ish import already done at module load; but throwing before we
    // touch three keeps construction cheap. We import three lazily via a getter.
    const THREE = WebGLScene._three;
    if (!THREE) throw new Error("three not loaded");

    this.mount = mount;
    this.role = role;
    this.world = world;
    this.THREE = THREE;
    this.roomColor = new THREE.Color(world.color || "#3aa0ff");

    const w = mount.clientWidth || 640;
    const h = mount.clientHeight || 420;

    // WebGLRenderer throws if no context — that's our degrade trigger.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: true, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: false,
    });
    // force a context check: getContext returns null-ish on failure in some builds
    if (!this.renderer.getContext()) throw new Error("no webgl context");

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
    this.camera.position.set(0, 6.2, 8.4);
    this.camera.lookAt(0, 0, 0);
    this._buildRoom();
    this._buildPortal();
    this._buildAvatar();

    this.phase = role === "source" ? HANDOFF_PHASES.IDLE : HANDOFF_PHASES.WAITING;
    this._t0 = performance.now();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
  }

  _buildRoom() {
    this.canonicalContent = mountCanonicalWorldContent(
      this.scene,
      this.THREE,
      this.world,
      { includeDebugGrid: true },
    );
  }
  _buildPortal() {
    const T = this.THREE;
    const isSource = this.role === "source";
    const pos = isSource ? [2.8, 0, -2.8] : [0, 0, 3.6];
    this.portalGroup = new T.Group();
    this.portalGroup.position.set(pos[0], 0.02, pos[2]);
    this.portalRingMat = new T.MeshStandardMaterial({
      color: isSource ? 0x66e0ff : 0xffc266, emissive: isSource ? 0x1b6f8a : 0x8a5a1b,
      emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.3 });
    const ring = new T.Mesh(new T.TorusGeometry(1.15, 0.12, 16, 48), this.portalRingMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 1.15; this.portalGroup.add(ring);
    this.portalDiscMat = new T.MeshBasicMaterial({ color: isSource ? 0x2bd4ff : 0xffb14d, transparent: true, opacity: 0.18, side: T.DoubleSide });
    const disc = new T.Mesh(new T.CircleGeometry(1.05, 40), this.portalDiscMat);
    disc.rotation.x = -Math.PI / 2; disc.position.y = 0.03; this.portalGroup.add(disc);
    this.scene.add(this.portalGroup);
  }
  _buildAvatar() {
    const T = this.THREE;
    this.avatarGroup = new T.Group();
    this.avatarBodyMat = new T.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222233, roughness: 0.5 });
    const body = new T.Mesh(new T.CapsuleGeometry(0.32, 0.7, 6, 14), this.avatarBodyMat); body.position.y = 0.8; this.avatarGroup.add(body);
    const head = new T.Mesh(new T.SphereGeometry(0.26, 20, 20), this.avatarBodyMat); head.position.y = 1.5; this.avatarGroup.add(head);
    const nose = new T.Mesh(new T.ConeGeometry(0.1, 0.28, 12), new T.MeshStandardMaterial({ color: 0xff4466 }));
    nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.5, 0.28); this.avatarGroup.add(nose);
    if (this.role === "source") {
      const sp = (this.world.avatar && this.world.avatar.spawn_position) || [0, 0, 3.2];
      this.avatarGroup.position.set(sp[0], 0, sp[2]); this.avatarGroup.visible = true;
    } else { this.avatarGroup.visible = false; }
    this.scene.add(this.avatarGroup);
  }
  setAvatar(avatar) {
    if (!avatar) { this.avatarGroup.visible = false; return; }
    this.avatarGroup.visible = true;
    const p = avatar.position || [0, 0, 0];
    this.avatarGroup.position.set(p[0], 0, p[2]);
    this.avatarGroup.rotation.y = avatar.rotation_y || 0;
  }
  setPhase(phase) { this.phase = phase; }
  _loop() {
    const t = (performance.now() - this._t0) / 1000;
    let base = 0.5;
    if (this.phase === HANDOFF_PHASES.PORTAL_ACTIVE) base = 1.4;
    if (this.phase === HANDOFF_PHASES.DEPARTED) base = 1.9;
    if (this.phase === HANDOFF_PHASES.WAITING) base = 0.45;
    if (this.phase === HANDOFF_PHASES.ARRIVED) base = 1.6;
    const pulse = base + Math.sin(t * 3) * 0.25;
    this.portalRingMat.emissiveIntensity = Math.max(0.15, pulse);
    this.portalDiscMat.opacity = 0.14 + Math.max(0, pulse - 0.5) * 0.22;
    this.portalGroup.rotation.y = t * 0.4;
    if (this.role === "source" && this.phase === HANDOFF_PHASES.DEPARTED) {
      this.avatarBodyMat.transparent = true;
      this.avatarBodyMat.opacity = Math.max(0.05, 0.9 - (t % 1.0));
      this.avatarGroup.scale.setScalar(0.6 + Math.max(0.05, 1 - ((t * 0.6) % 1.0)) * 0.4);
    } else if (this.role === "source") {
      this.avatarBodyMat.opacity = 1; this.avatarGroup.scale.setScalar(1);
    }
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(this._loop);
  }
  resize() {
    const w = this.mount.clientWidth || 640, h = this.mount.clientHeight || 420;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h);
  }
  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}
WebGLScene._three = null; // set by module init below

/* --------------------------- Canvas2D degrade ------------------------------ */
class Canvas2DScene {
  constructor(mount, role, world) {
    this.mount = mount; this.role = role; this.world = world;
    this.roomColor = world.color || (role === "source" ? "#3aa0ff" : "#ff7a3a");
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%"; this.canvas.style.height = "100%";
    this._resizeCanvas();
    mount.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.phase = role === "source" ? HANDOFF_PHASES.IDLE : HANDOFF_PHASES.WAITING;
    this.avatar = role === "source" ? { position: (world.avatar && world.avatar.spawn_position) || [0, 0, 3.2] } : null;
    this._t0 = performance.now();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
    this._onResize = () => { this._resizeCanvas(); };
    window.addEventListener("resize", this._onResize);
  }
  _resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.mount.clientWidth || 640, h = this.mount.clientHeight || 420;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this._dpr = dpr; this._w = w; this._h = h;
  }
  setPhase(phase) { this.phase = phase; }
  setAvatar(avatar) { this.avatar = avatar; }
  // world (x,z) in ~[-6,6] -> canvas px (top-down)
  _proj(x, z) {
    const cx = this._w / 2, cy = this._h / 2;
    const scale = Math.min(this._w, this._h) / 13;
    return [cx + x * scale, cy + z * scale];
  }
  _loop() {
    const ctx = this.ctx, t = (performance.now() - this._t0) / 1000;
    ctx.save();
    ctx.scale(this._dpr, this._dpr);
    ctx.clearRect(0, 0, this._w, this._h);

    // room floor
    ctx.fillStyle = this.roomColor + "22";
    ctx.fillRect(0, 0, this._w, this._h);
    // grid
    ctx.strokeStyle = "rgba(136,170,204,0.28)"; ctx.lineWidth = 1;
    for (let i = -6; i <= 6; i++) {
      const [ax, ay] = this._proj(i, -6), [bx, by] = this._proj(i, 6);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const [cx, cy] = this._proj(-6, i), [dx, dy] = this._proj(6, i);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(dx, dy); ctx.stroke();
    }

    // portal
    const isSource = this.role === "source";
    const [px, pz] = isSource ? [2.8, -2.8] : [0, 3.6];
    const [portX, portY] = this._proj(px, pz);
    let base = 0.4;
    if (this.phase === HANDOFF_PHASES.PORTAL_ACTIVE) base = 0.9;
    if (this.phase === HANDOFF_PHASES.DEPARTED) base = 1.0;
    if (this.phase === HANDOFF_PHASES.ARRIVED) base = 0.95;
    const glow = base + Math.sin(t * 3) * 0.2;
    const rPx = Math.min(this._w, this._h) / 13 * 1.15;
    ctx.beginPath(); ctx.arc(portX, portY, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = isSource ? `rgba(43,212,255,${Math.min(1, glow)})` : `rgba(255,177,77,${Math.min(1, glow)})`;
    ctx.lineWidth = 6; ctx.stroke();
    ctx.fillStyle = isSource ? `rgba(43,212,255,${0.12 + glow * 0.12})` : `rgba(255,177,77,${0.12 + glow * 0.12})`;
    ctx.fill();

    // avatar
    if (this.avatar) {
      const a = this.avatar.position || [0, 0, 0];
      const [axp, ayp] = this._proj(a[0], a[2]);
      let alpha = 1, rad = 12;
      if (this.role === "source" && this.phase === HANDOFF_PHASES.DEPARTED) {
        alpha = Math.max(0.1, 0.9 - (t % 1.0)); rad = 12 * Math.max(0.4, 1 - ((t * 0.6) % 1.0));
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(axp, ayp, rad, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff"; ctx.fill();
      ctx.strokeStyle = "#ff4466"; ctx.lineWidth = 2; ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // corner label so a screenshot self-documents the degrade path
    ctx.fillStyle = "rgba(255,204,85,0.9)"; ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.fillText("canvas2d fallback (no GPU) — top-down depiction", 12, this._h - 12);

    ctx.restore();
    this._raf = requestAnimationFrame(this._loop);
  }
  resize() { this._resizeCanvas(); }
  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}

// Load three once and hand it to WebGLScene. If the import fails, WebGLScene
// construction throws and we degrade — the app still runs.
try {
  const THREE = await import("./vendor/three/three.module.js");
  WebGLScene._three = THREE;
} catch (e) {
  console.warn("[scene-runtime] three import failed; canvas2d fallback will be used", e && e.message);
}
