// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-movement-camera-controller.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: none, except where a comment says so. X_ITE uses this file too.

import { createOrbitCameraController, ORBIT_CAMERA_DEFAULTS } from "./orbit-camera-controller.mjs";

// X3DOM movement/camera controller — Phase 1 of the X3DOM render-parity plan. Sibling to
// movement-camera-controller.mjs, not a branch inside it: the three.js controller and its own
// callers are untouched by this file. Brings the X3DOM path from third-person-orbit-only to:
//
// - First person: a fixed local eye offset above the avatar root, since X3DOM's glTF <Inline>
//   avatar has no bone/skeleton API the way three-vrm exposes `getRawBoneNode("head")`. The
//   offset reuses the exact [0, 1.55, 0.12] constant avatar-equipment-layer.js's fallback rig
//   already uses as a non-bone "head" anchor for this codebase's own non-VRM case — a proven
//   approximation, not a new invention.
// - Jump: LiveAdapter.stepAvatar() already implements full shared/backend-authoritative vertical
//   physics keyed on a boolean `input.jump` field (see live-adapter.js's integrateAirportVerticalMotion
//   call) — wiring Space into that flag is mechanical, no new physics needed here.
// - Camera-wall occlusion (third-person only): X3DOMRenderAdapter has no arbitrary-3D-segment
//   raycast, only pickViewCenter() (a screen-space pick at the current canvas center). Because
//   setCameraPose()'s lookAt always points the camera exactly at the orbit focus point in
//   third-person mode, a view-center pick after applying that pose tests the identical segment
//   three.js's updateCameraWallOcclusion would — so this is a legitimate, if narrower,
//   approximation of that system, not a different technique pretending to be the same one. Not
//   applied in first person: there the camera sits at the avatar's own eye, so there is no
//   external "wall between camera and avatar" case for this system to cover.
//
// Deliberately NOT covered here (see the parity plan): portal-aperture occlusion (needs Phase 2's
// portal geometry to exist first) and avatar foot-grounding calibration (no VRM bone origin-offset
// issue exists for a bare glTF root positioned directly from backend state, so there is nothing to
// calibrate against).

const ORBIT_SPEED_RAD_PER_PX = 0.0052;
const FIRST_PERSON_EYE_OFFSET = Object.freeze([0, 1.55, 0.12]);
const FIRST_PERSON_MIN_POLAR_RAD = -1.25;
const FIRST_PERSON_MAX_POLAR_RAD = 1.25;
const OCCLUSION_HYSTERESIS_M = 0.08;

function clampRange(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeAngle(angle) {
    let a = angle;
    while (a > Math.PI)
        a -= Math.PI * 2;
    while (a < -Math.PI)
        a += Math.PI * 2;
    return a;
}

function buttonStyle() {
    return [
        "position:absolute", "top:72px", "right:12px", "z-index:6", "padding:6px 10px", // Lab change: below the lab's header
        "background:rgba(8,12,26,0.82)", "color:#dbe8ff", "border:1px solid rgba(43,212,255,0.4)",
        "border-radius:8px", "font:600 11px ui-monospace,Menlo,monospace", "letter-spacing:0.02em", "cursor:pointer",
    ].join(";");
}

/**
 * @param adapter X3DOMRenderAdapter instance (already attached/ready).
 * @param camera the adapter's viewpoint element (adapter.camera).
 * @param dragEl element to bind mouse-drag look controls to (typically the <x3d> host).
 * @param sceneMount container to append the first/third-person toggle button into.
 * @param onModeChange(mode) called with "first_person"|"third_person" whenever the mode changes,
 *   so the caller can hide/show the avatar body (this controller has no avatar handle of its own —
 *   avatar lifecycle belongs to the HumanoidProvider, not the camera).
 */
export function createX3domMovementCameraController({ adapter, camera, dragEl, sceneMount, onModeChange = () => { }, windowTarget = window, documentTarget = document, }) {
    const orbit = createOrbitCameraController({ adapter, camera });
    let mode = "third_person";
    let pointerYaw = 0;
    let pointerPitch = ORBIT_CAMERA_DEFAULTS.polar_rad;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let occludedNode = null;
    let modeButton = null;
    let lastAppliedPose = null;

    function seed(opts) {
        orbit.seed(opts);
        pointerYaw = normalizeAngle(orbit.state.azimuth + Math.PI);
        pointerPitch = 0;
    }

    function movementBasisYaw() {
        return mode === "first_person" ? normalizeAngle(pointerYaw) : normalizeAngle(orbit.state.azimuth + Math.PI);
    }

    // Re-seeds the third-person orbit state from a portal crossing's { position, focus } camera
    // mapping (the same shape movement-camera-controller.mjs's applyCrossingCameraMapping consumes
    // on the three.js side, produced by mapCameraAcrossCrossing in live-adapter-portal-geometry.mjs)
    // by inverting orbit-camera-controller.mjs's own pose formula: position = focus + [sin(az)*cosPolar,
    // sin(polar), cos(az)*cosPolar]*distance. Restores heading continuity across a crossing instead
    // of snapping back to the default azimuth/distance.
    function applyCrossingCameraMapping(mapping) {
        if (!mapping || !Array.isArray(mapping.position) || !Array.isArray(mapping.focus))
            return false;
        const focus = mapping.focus.slice(0, 3);
        const dx = mapping.position[0] - focus[0];
        const dy = mapping.position[1] - focus[1];
        const dz = mapping.position[2] - focus[2];
        const distance = Math.max(0.1, Math.hypot(dx, dy, dz));
        const horizontal = Math.hypot(dx, dz);
        const azimuth = Math.atan2(dx, dz);
        const polar = clampRange(Math.atan2(dy, horizontal), ORBIT_CAMERA_DEFAULTS.min_polar_rad, ORBIT_CAMERA_DEFAULTS.max_polar_rad);
        orbit.state.focus = focus;
        orbit.state.focusInitialized = true;
        orbit.state.azimuth = orbit.state.targetAzimuth = azimuth;
        orbit.state.polar = orbit.state.targetPolar = polar;
        orbit.state.distance = orbit.state.targetDistance = distance;
        if (mode === "first_person") {
            pointerYaw = normalizeAngle(azimuth + Math.PI);
            pointerPitch = 0;
        }
        orbit.apply();
        return true;
    }

    function restoreOcclusion() {
        if (!occludedNode)
            return;
        try {
            adapter.setVisible(occludedNode, true);
        }
        catch { /* best-effort restore */ }
        occludedNode = null;
    }

    function applyOcclusion(focusDistance) {
        let hit = null;
        try {
            hit = adapter.pickViewCenter();
        }
        catch {
            hit = null;
        }
        if (!hit || !Number.isFinite(hit.distance) || !Number.isFinite(focusDistance)) {
            restoreOcclusion();
            return;
        }
        const blocking = hit.distance < focusDistance - OCCLUSION_HYSTERESIS_M;
        if (!blocking) {
            restoreOcclusion();
            return;
        }
        if (occludedNode && occludedNode !== hit.node)
            restoreOcclusion();
        if (occludedNode !== hit.node) {
            try {
                adapter.setVisible(hit.node, false);
                occludedNode = hit.node;
            }
            catch { /* best-effort */ }
        }
    }

    function applyFirstPersonPose(avatarPosition) {
        if (!Array.isArray(avatarPosition))
            return;
        const cosPitch = Math.cos(pointerPitch);
        const direction = [Math.sin(pointerYaw) * cosPitch, Math.sin(pointerPitch), Math.cos(pointerYaw) * cosPitch];
        const position = [
            (Number(avatarPosition[0]) || 0) + FIRST_PERSON_EYE_OFFSET[0],
            (Number(avatarPosition[1]) || 0) + FIRST_PERSON_EYE_OFFSET[1],
            (Number(avatarPosition[2]) || 0) + FIRST_PERSON_EYE_OFFSET[2],
        ];
        const lookAt = [position[0] + direction[0], position[1] + direction[1], position[2] + direction[2]];
        adapter.setCameraPose(camera, { position, lookAt });
        lastAppliedPose = { position, lookAt, lookYaw: pointerYaw };
    }

    function step(deltaSeconds, avatarPosition, motionReduced = false) {
        if (mode === "first_person") {
            restoreOcclusion();
            applyFirstPersonPose(avatarPosition);
            return;
        }
        orbit.step(deltaSeconds, avatarPosition, motionReduced);
        const pose = orbit.currentPose();
        if (!pose)
            return;
        lastAppliedPose = pose;
        const focusDistance = Math.hypot(pose.position[0] - pose.lookAt[0], pose.position[1] - pose.lookAt[1], pose.position[2] - pose.lookAt[2]);
        applyOcclusion(focusDistance);
        // Keeps the render loop alive through the damped ease-out after the user releases the
        // drag (same needRender-gating issue the mousemove handler's own requestRender() call
        // fixes for the active-drag case) — without this, easing would freeze on whatever pose
        // happened to be current at the exact frame dragging stopped, rather than gliding the
        // rest of the way to the released target.
        const { azimuth, targetAzimuth, polar, targetPolar, distance, targetDistance } = orbit.state;
        const settled = Math.abs(targetAzimuth - azimuth) < 1e-4
            && Math.abs(targetPolar - polar) < 1e-4
            && Math.abs(targetDistance - distance) < 1e-4;
        if (!settled)
            adapter.requestRender();
    }

    function toggleMode() {
        restoreOcclusion();
        if (mode === "third_person") {
            pointerYaw = normalizeAngle(orbit.state.azimuth + Math.PI);
            pointerPitch = 0;
            mode = "first_person";
        }
        else {
            orbit.state.azimuth = orbit.state.targetAzimuth = normalizeAngle(pointerYaw + Math.PI);
            mode = "third_person";
        }
        updateModeButton();
        onModeChange(mode);
    }

    function updateModeButton() {
        if (modeButton)
            modeButton.textContent = mode === "first_person" ? "1st person" : "3rd person";
    }

    function ensureModeButton() {
        if (!sceneMount || modeButton)
            return;
        modeButton = documentTarget.createElement("button");
        modeButton.id = "btn-x3dom-camera-mode";
        modeButton.type = "button";
        modeButton.title = "Toggle first/third-person camera (C)";
        modeButton.style.cssText = buttonStyle();
        modeButton.addEventListener("mousedown", (event) => event.stopPropagation());
        modeButton.addEventListener("click", (event) => { event.stopPropagation(); toggleMode(); });
        sceneMount.appendChild(modeButton);
        updateModeButton();
    }

    function attachPointerControls() {
        if (!dragEl)
            return;
        // Capture phase, not bubble: X3DOM's own internal canvas (nested inside dragEl) calls
        // stopPropagation() on every mousemove over it for its own hover-picking, regardless of
        // NavigationInfo type — confirmed by tracing propagation directly (bubble-phase listeners
        // on dragEl/window never see a single mousemove during a real drag; mousedown/mouseup are
        // unaffected, only mousemove is stopped). A capture-phase listener runs on the way down,
        // before the event ever reaches that canvas-bound bubble handler, so it isn't affected by
        // the later stopPropagation() call.
        dragEl.addEventListener("mousedown", (event) => { dragging = true; lastX = event.clientX; lastY = event.clientY; }, true);
        windowTarget.addEventListener("mouseup", () => { dragging = false; }, true);
        windowTarget.addEventListener("mousemove", (event) => {
            if (!dragging)
                return;
            const dx = event.clientX - lastX;
            const dy = event.clientY - lastY;
            lastX = event.clientX;
            lastY = event.clientY;
            if (mode === "first_person") {
                pointerYaw = normalizeAngle(pointerYaw - dx * ORBIT_SPEED_RAD_PER_PX);
                pointerPitch = clampRange(pointerPitch - dy * ORBIT_SPEED_RAD_PER_PX, FIRST_PERSON_MIN_POLAR_RAD, FIRST_PERSON_MAX_POLAR_RAD);
            }
            else {
                orbit.state.targetAzimuth -= dx * ORBIT_SPEED_RAD_PER_PX;
                orbit.state.targetPolar = clampRange(orbit.state.targetPolar + dy * ORBIT_SPEED_RAD_PER_PX, ORBIT_CAMERA_DEFAULTS.min_polar_rad, ORBIT_CAMERA_DEFAULTS.max_polar_rad);
            }
            // This only updates plain JS state (pointerYaw/pointerPitch or orbit.state's target*
            // fields) — no X3D DOM attribute changes, so nothing here trips X3DOM's own
            // needRender tracking on its own. Without an explicit wake, onEnterFrame() (which
            // drives step()'s actual setCameraPose() calls) stops firing once the render loop
            // goes idle, and drag input piles up invisibly until something unrelated happens to
            // wake it again — the real cause of "camera skips frames while dragging". See
            // requestRender()'s own comment in x3dom-render-adapter.mjs for the full mechanism.
            adapter.requestRender();
        }, true);
    }

    function attachKeyboardToggle() {
        windowTarget.addEventListener("keydown", (event) => {
            if (event.code === "KeyC")
                toggleMode();
        });
    }

    ensureModeButton();
    attachPointerControls();
    attachKeyboardToggle();

    return {
        orbit,
        seed,
        step,
        toggleMode,
        movementBasisYaw,
        applyCrossingCameraMapping,
        mode: () => mode,
        currentPose: () => lastAppliedPose,
    };
}
