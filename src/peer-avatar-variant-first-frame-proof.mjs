/**
 * PEER AVATAR CORRECT-FROM-FIRST-FRAME PROOF
 * (deterministic; no browser, no WebGL, no load gate).
 *
 * THE REPORTED DEFECT: crossing a portal in one user's view and watching from
 * ANOTHER user's view, the crossing avatar loaded the WRONG avatar first (the
 * default) and had to reload the correct one for that user — a visible
 * default->correct flicker on the freshly-rendered remote peer.
 *
 * ROOT CAUSE (diagnosed — hypothesis "c" of the task; "a"/"b" RULED OUT below):
 *   The peer's real avatar_variant IS known at frame 0. It rides every
 *   player-pose broadcast (web/live-adapter-peer-presence-reducer.mjs:146) and
 *   SURVIVES a crossing: the exit packet carries
 *   avatar_context.avatar_variant (traversal-controller:751) and the arrival
 *   rebuild restores it with avatarMode "merge" (traversal-controller:1004).
 *   So peer.avatar_variant is the correct, non-default value when the observer
 *   first instantiates the peer's render layer. => (a) "missing from the
 *   join/initial payload" and (b) "dropped in the crossing promotion" are both
 *   FALSE (pinned below).
 *
 *   The flicker was purely a REVEAL-ORDER defect in the render layer. The
 *   shared AvatarEquipmentLayer (web/avatar-equipment-layer.js — a separate
 *   lane, not editable here) takes NO variant at construction: its _init()
 *   synchronously starts a DEFAULT_AVATAR_VARIANT model load (status.avatar_
 *   variant is the default until a switch lands: line 908 + `await
 *   this._loadVrm()` line 1043). The pre-fix app.js peer path (web/app.js
 *   syncPeerAvatars) then (1) primed `layer.avatar = peerAvatar` immediately,
 *   letting _init's _syncAvatarTransform REVEAL the default rig, and (2) on
 *   ready called setAvatar (which reveals) and only THEN kicked off the async
 *   switchAvatarVariant to the correct model. Visible default, then swap.
 *
 * THE FIX:
 *   Keep the peer rig HIDDEN (leave layer.avatar null so _syncAvatarTransform
 *   holds avatarRig.visible=false) until the peer's OWN variant is the ACTIVE
 *   model, then reveal. switchAvatarVariant loads+adopts the correct model
 *   WITHOUT touching visibility, so the swap happens off-screen and the FIRST
 *   visible frame is already correct. A __variantPrimed gate stops the per-tick
 *   stream from revealing the default before priming completes. No eager
 *   preload: only the default the un-editable layer forces + the peer's
 *   own variant — the same fetch set the pre-fix reveal-then-switch already paid.
 *
 * HOW IT CANNOT LIE:
 *   - The observable state machine of the REAL AvatarEquipmentLayer (default
 *     load on construct, invisible rig, switch-without-reveal, setAvatar-reveals)
 *     is SOURCE-PINNED against web/avatar-equipment-layer.js — the fake used
 *     here fails to build if those lines drift.
 *   - The FIXED reveal order run here is SOURCE-PINNED against the exact shipped
 *     app.js statements (switch-before-reveal + __variantPrimed gate + the
 *     removal of the immediate `layer.avatar = peerAvatar` prime). Reverting the
 *     fix in app.js turns this proof RED.
 *   - The data-availability claim (variant known at frame 0, ruling out a/b) is
 *     SOURCE-PINNED against the reducer + traversal-controller.
 *   - CONTROLLED RED (oracle teeth): the reconstructed pre-fix reveal order —
 *     immediate prime + reveal-then-switch — REPRODUCES the
 *     default-first frame and FAILS the frame-0 criterion. A criterion that
 *     cannot fail is not evidence; this one fails on the pre-fix path and passes
 *     on the fix.
 *
 * No ports bound, no git, claim boundary unchanged (local application-level
 * proof; no TeleportXR/production/standards claim).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const APP = readFileSync(resolve(repoRoot, "web/app.js"), "utf8");
const LAYER = readFileSync(resolve(repoRoot, "web/avatar-equipment-layer.js"), "utf8");
const REDUCER = readFileSync(resolve(repoRoot, "web/live-adapter-peer-presence-reducer.mjs"), "utf8");
const TRAVERSAL = readFileSync(resolve(repoRoot, "web/live-adapter-portal-traversal-controller.mjs"), "utf8");

const failures = [];
const pins = [];
function pin(label, present) {
  pins.push({ label, present: !!present });
  if (!present) failures.push(`SOURCE-PIN FAILED: ${label}`);
}
function check(label, cond) {
  if (!cond) failures.push(`ASSERT FAILED: ${label}`);
  return !!cond;
}

// ---------------------------------------------------------------------------
// PART A — SOURCE PINS (keep the fake faithful and tie the proof to shipped code)
// ---------------------------------------------------------------------------

// A1. Variant identity constants used by the harness, pinned to the real module.
const DEFAULT_VARIANT = "readyplayerme-cyberpunk";
const NON_DEFAULT_VARIANT = "rpm-female-ninja"; // a real non-default GLB variant
pin(`layer declares DEFAULT_AVATAR_VARIANT = "${DEFAULT_VARIANT}"`,
  LAYER.includes(`DEFAULT_AVATAR_VARIANT = "${DEFAULT_VARIANT}"`));
pin(`layer declares non-default variant key "${NON_DEFAULT_VARIANT}"`,
  LAYER.includes(`key: "${NON_DEFAULT_VARIANT}"`));

// A2. The layer takes NO variant at construction; its status defaults to the
// default variant and _init() synchronously starts a default-variant load.
pin("layer status inits avatar_variant to DEFAULT_AVATAR_VARIANT (constructor)",
  LAYER.includes("avatar_variant: DEFAULT_AVATAR_VARIANT,"));
pin("layer _init() awaits this._loadVrm() with NO argument (loads the default first)",
  LAYER.includes("await this._loadVrm();"));
pin("layer _loadVrm() default variant is read from status.avatar_variant",
  /_loadVrm\(variantKey = this\.status\.avatar_variant \|\| DEFAULT_AVATAR_VARIANT\)/.test(LAYER));

// A3. setAvatar REVEALS (visibility from transition_visual) and, only then,
// triggers switchAvatarVariant when the requested variant differs.
pin("setAvatar reveals via avatarRig.visible = ... visual.visible !== false",
  LAYER.includes("this.avatarRig.visible = reducedMotion || visual.visible !== false;"));
pin("setAvatar switches variant when requestedVariant !== status.avatar_variant",
  LAYER.includes("this.switchAvatarVariant(requestedVariant);"));
pin("null avatar hides the rig (avatarRig.visible = false)",
  /if \(!this\.avatar\) \{[\s\S]*?this\.avatarRig\.visible = false;/.test(LAYER));

// A4. switchAvatarVariant loads the new model fully then adopts it, WITHOUT
// touching avatarRig.visible (so an off-screen swap stays off-screen).
const switchBody = LAYER.slice(
  LAYER.indexOf("async switchAvatarVariant(variantKey)"),
  LAYER.indexOf("async switchAvatarVariant(variantKey)") + 1200,
);
pin("switchAvatarVariant loads then _adoptVrmModel", switchBody.includes("this._adoptVrmModel("));
pin("switchAvatarVariant never sets avatarRig.visible", !switchBody.includes("avatarRig.visible"));
pin("_adoptVrmModel sets status.avatar_variant = variant.key (active variant follows the load)",
  LAYER.includes("this.status.avatar_variant = variant.key;"));

// A5. DATA IS PRESENT AT FRAME 0 — rules out hypotheses (a) and (b).
pin("(a-ruled-out) reducer broadcasts avatar_variant on every player-pose",
  REDUCER.includes("avatar_variant: avatar.avatar_variant || defaultAvatarVariant,"));
pin("(a-ruled-out) reducer records peer avatar_variant from the pose stream",
  REDUCER.includes("avatar_variant: message.avatar_variant || defaultAvatarVariant,"));
pin("(a-ruled-out) reducer exposes peer avatar_variant in the co-present debug view",
  REDUCER.includes("avatar_variant: pose.avatar_variant,"));
pin("(b-ruled-out) crossing EXIT packet carries avatar_context.avatar_variant",
  TRAVERSAL.includes("avatar_variant: host.avatar.avatar_variant || assets.defaultAvatarVariant,"));
pin("(b-ruled-out) crossing ARRIVAL rebuild restores avatar_variant from the packet",
  TRAVERSAL.includes("avatar_variant: packet.avatar_context.avatar_variant || assets.defaultAvatarVariant,"));

// A6. THE FIX IS SHIPPED IN app.js (revert => this proof goes RED).
pin("app.js: peer layer starts NOT primed (__variantPrimed = false)",
  APP.includes("layer.__variantPrimed = false;"));
pin("app.js: on ready, SWITCH to the peer's own variant BEFORE revealing",
  APP.includes("await layer.switchAvatarVariant(wantVariant);"));
pin("app.js: reveal (setAvatar) only after priming; mark primed",
  APP.includes("layer.__variantPrimed = true;") &&
  APP.includes("layer.setAvatar(layer.__latestPeerAvatar || peerAvatar);"));
pin("app.js: per-tick reveal gated behind __variantPrimed",
  APP.includes("if (layer.__variantPrimed && layer.isSettled && layer.isSettled()) layer.setAvatar(peerAvatar);"));
// The pre-fix flicker line — an immediate `layer.avatar = peerAvatar;` inside
// the peer instantiation block — must be GONE.
pin("app.js: the pre-fix immediate-prime `layer.avatar = peerAvatar;` is removed",
  !APP.includes("layer.avatar = peerAvatar;"));

// A known set of valid variant keys (pinned to the module) — the fix guards its
// switch with `AVATAR_VARIANTS[wantVariant]`, so the harness models that lookup.
const KNOWN_VARIANTS = new Set(
  [...LAYER.matchAll(/key: "([a-z0-9-]+)"/g)].map((m) => m[1]),
);
pin("known variant set includes the default", KNOWN_VARIANTS.has(DEFAULT_VARIANT));
pin("known variant set includes the non-default test variant", KNOWN_VARIANTS.has(NON_DEFAULT_VARIANT));

// ---------------------------------------------------------------------------
// PART B — FAITHFUL FAKE of the AvatarEquipmentLayer observable state machine.
//   Every branch below is the behavior pinned in PART A. Async model loads are
//   modeled as an explicit queue the harness drains ONE at a time, so we can
//   sample the (visible, active-variant) render state between loads.
// ---------------------------------------------------------------------------

class FakeAvatarEquipmentLayer {
  constructor() {
    this.avatar = null; // layer.js:869 — starts null
    this.status = { avatar_variant: DEFAULT_VARIANT, settled: false, real_vrm_loaded: false };
    this.avatarRig = { visible: false }; // layer.js:1035
    this._loads = []; // pending model loads (FIFO)
    this._switchInFlight = false;
    this.ready = this._init(); // layer.js:988
  }
  _beginLoad(variantKey) {
    return new Promise((res) => this._loads.push({ variantKey, resolve: res }));
  }
  /** Harness clock: complete the oldest pending model load == real _adoptVrmModel. */
  resolveNextLoad() {
    const job = this._loads.shift();
    if (!job) return false;
    // _adoptVrmModel: active variant follows the loaded model (layer.js:1189);
    // it never touches avatarRig.visible (pinned A4).
    this.status.avatar_variant = job.variantKey;
    this.status.real_vrm_loaded = true;
    job.resolve();
    return true;
  }
  async _init() {
    await this._loadVrm(); // default variant captured at call-time (pinned A2)
    this._syncAvatarTransform(); // layer.js:1045 — reveals IFF this.avatar is set
    this.status.settled = true; // layer.js:1055
    return this;
  }
  async _loadVrm(variantKey = this.status.avatar_variant || DEFAULT_VARIANT) {
    await this._beginLoad(variantKey);
  }
  async switchAvatarVariant(variantKey) {
    if (!KNOWN_VARIANTS.has(variantKey)) return { ok: false };
    if (variantKey === this.status.avatar_variant && this.status.real_vrm_loaded) {
      return { ok: true, unchanged: true }; // layer.js:1370-1373
    }
    this._switchInFlight = true;
    this.status.settled = false; // layer.js:1381
    await this._beginLoad(variantKey); // load fully, then adopt (pinned A4)
    this._switchInFlight = false;
    this.status.settled = true; // layer.js:1396
    return { ok: true, variant: variantKey };
  }
  setAvatar(avatar) {
    this.avatar = avatar || null; // layer.js:1976
    this._syncAvatarTransform();
    const requestedVariant = this.avatar && this.avatar.avatar_variant; // layer.js:1981
    if (requestedVariant && KNOWN_VARIANTS.has(requestedVariant) &&
        requestedVariant !== this.status.avatar_variant) {
      this.switchAvatarVariant(requestedVariant); // layer.js:1987 (async, not awaited)
    }
  }
  _syncAvatarTransform() {
    if (!this.avatar) { this.avatarRig.visible = false; return; } // layer.js:2021-2024
    const visual = this.avatar.transition_visual || {};
    this.avatarRig.visible = visual.visible !== false; // layer.js:2031
  }
  isSettled() { return this.status.settled === true; } // layer.js:2049
}

async function flushMicrotasks(n = 20) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * Drive one render lifecycle and record the (visible, variant) at each frame.
 * `wire(layer, peerAvatar, frames)` installs the app-side reveal policy under
 * test. Returns the recorded frames.
 */
async function runLifecycle(wire) {
  const layer = new FakeAvatarEquipmentLayer();
  // The peer is co-present with a NON-DEFAULT variant, known at frame 0 (this is
  // exactly the crossing-promotion input: a fresh peer whose variant rode the
  // crossing packet). transition_visual.visible !== false => the rig is meant
  // to be on-screen once revealed.
  const peerAvatar = {
    avatar_variant: NON_DEFAULT_VARIANT,
    position: [1, 0, 2],
    transition_visual: { visible: true, scale: 1, spin_y: 0 },
  };
  const frames = [];
  const sample = () => frames.push({
    visible: layer.avatarRig.visible,
    variant: layer.status.avatar_variant,
  });

  wire(layer, peerAvatar); // install the reveal policy (fixed or pre-fix)
  await flushMicrotasks();
  sample(); // frame 0 — before any model load completes

  // Drain up to a few loads (default, then any switch), sampling between each.
  for (let step = 0; step < 6; step += 1) {
    const progressed = layer.resolveNextLoad();
    await flushMicrotasks();
    sample();
    if (!progressed && layer._loads.length === 0) break;
  }
  return { frames, layer, peerAvatar };
}

// ---------------------------------------------------------------------------
// PART C — THE TWO REVEAL POLICIES.
// ---------------------------------------------------------------------------

// C1. FIXED — the shipped app.js syncPeerAvatars order (pinned A6): rig stays
// hidden until the peer's own variant is the active model, then reveal.
function wireFixed(layer, peerAvatar) {
  layer.__latestPeerAvatar = peerAvatar;
  layer.__variantPrimed = false;
  // NOTE: layer.avatar is deliberately NOT set here.
  layer.ready.then(async () => {
    const latest = layer.__latestPeerAvatar || peerAvatar;
    const wantVariant = latest && latest.avatar_variant;
    if (wantVariant && KNOWN_VARIANTS.has(wantVariant) &&
        wantVariant !== layer.status.avatar_variant) {
      try { await layer.switchAvatarVariant(wantVariant); } catch { /* keep default */ }
    }
    layer.__variantPrimed = true;
    layer.setAvatar(layer.__latestPeerAvatar || peerAvatar);
  });
}

// C2. PRE-FIX — the reconstructed shipped-before-299 order: prime layer.avatar
// immediately (so _init reveals the default), reveal-then-switch on ready.
function wirePreFix(layer, peerAvatar) {
  layer.__latestPeerAvatar = peerAvatar;
  layer.avatar = peerAvatar; // <-- the removed immediate-prime (the flicker seed)
  layer.ready.then(() => {
    if (layer.__latestPeerAvatar) layer.setAvatar(layer.__latestPeerAvatar);
  });
}

// ---------------------------------------------------------------------------
// PART D — RUN + ASSERT.
// ---------------------------------------------------------------------------

const fixed = await runLifecycle(wireFixed);
const prefix = await runLifecycle(wirePreFix);

const fixedFirstVisible = fixed.frames.find((f) => f.visible) || null;
const prefixFirstVisible = prefix.frames.find((f) => f.visible) || null;

// GREEN criterion: with the fix, the FIRST rendered frame in which the peer rig
// is visible shows the peer's DECLARED (non-default) variant — never the default.
const fixedFrame0Correct = check(
  `FIX: first visible frame renders the declared variant "${NON_DEFAULT_VARIANT}" (got "${fixedFirstVisible?.variant}")`,
  !!fixedFirstVisible && fixedFirstVisible.variant === NON_DEFAULT_VARIANT,
);
check(
  "FIX: the default variant is NEVER the visible variant in any frame",
  fixed.frames.every((f) => !f.visible || f.variant !== DEFAULT_VARIANT),
);
check("FIX: the peer does become visible (not stuck hidden)", !!fixedFirstVisible);

// CONTROLLED RED: the pre-fix order MUST fail the same criterion — its first
// visible frame is the DEFAULT (the flicker the user saw). If this ever renders
// correct-first, the oracle has no teeth and the whole proof is void.
const prefixIsRed = check(
  `RED-CASE: pre-fix first visible frame is the DEFAULT "${DEFAULT_VARIANT}" (got "${prefixFirstVisible?.variant}") — reproduces the flicker`,
  !!prefixFirstVisible && prefixFirstVisible.variant === DEFAULT_VARIANT,
);
check(
  "RED-CASE: pre-fix FAILS the frame-0 criterion (first visible != declared variant)",
  !!prefixFirstVisible && prefixFirstVisible.variant !== NON_DEFAULT_VARIANT,
);
// Both orders converge on the correct variant eventually (the flicker was
// transient) — proving the ONLY difference is the FIRST visible frame.
check(
  "both orders end on the correct variant (difference is only the first frame)",
  fixed.frames.at(-1)?.variant === NON_DEFAULT_VARIANT &&
  prefix.frames.at(-1)?.variant === NON_DEFAULT_VARIANT,
);

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

const ok = failures.length === 0;
const manifest = {
  work_order: "runtime",
  validation: "peer-avatar-correct-from-first-frame (no default->correct flicker)",
  deterministic: true,
  browser: false,
  diagnosed_root_cause: "c — render-layer reveal-order; variant present at frame 0 so (a)/(b) ruled out",
  default_variant: DEFAULT_VARIANT,
  non_default_peer_variant: NON_DEFAULT_VARIANT,
  fix_seam: "web/app.js syncPeerAvatars — hide-until-own-variant-active, switch-before-reveal, __variantPrimed gate",
  measurements: {
    fix_first_visible_frame: fixedFirstVisible,
    fix_frames: fixed.frames,
    prefix_first_visible_frame: prefixFirstVisible,
    prefix_frames: prefix.frames,
    fix_frame0_correct: fixedFrame0Correct,
    prefix_is_controlled_red: prefixIsRed,
  },
  source_pins: pins,
  failures,
  status: ok ? "PASS" : "FAIL",
};

const evidenceDir = resolve(repoRoot, "diagnostics");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(
  resolve(evidenceDir, "runtime-peer-avatar-variant-first-frame-diagnostics.json"),
  JSON.stringify(manifest, null, 2),
);

const line = (s) => process.stdout.write(`${s}\n`);
line("runtime peer-avatar correct-from-first-frame validation");
line(`  root cause: (c) render-layer reveal order; (a)/(b) ruled out by source pins`);
line(`  FIX   first visible frame variant: ${fixedFirstVisible?.variant} (want ${NON_DEFAULT_VARIANT})`);
line(`  RED   first visible frame variant: ${prefixFirstVisible?.variant} (pre-fix default flicker)`);
line(`  source pins: ${pins.filter((p) => p.present).length}/${pins.length} present`);
line(`  diagnostics: diagnostics/peer-avatar-variant-first-frame-diagnostics.json`);
if (!ok) {
  line("STATUS: FAIL");
  for (const f of failures) line(`  - ${f}`);
  process.exit(1);
}
line("STATUS: PASS");
