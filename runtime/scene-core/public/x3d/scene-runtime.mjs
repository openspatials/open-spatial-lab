import { composeTRS, decomposeTRS, multiplyMat4, transformPoint, IDENTITY_MAT4 } from "../render-adapter/spatial-math.mjs";
import { isX3dDocument } from "./json-document.mjs";
import { sealX3dValue, validateX3dField } from "./profile.mjs";

function rotationQuaternion([x, y, z, angle]) {
    const scale = Math.sin(angle / 2) / (Math.hypot(x, y, z) || 1);
    return [x * scale, y * scale, z * scale, Math.cos(angle / 2)];
}

function quaternionRotation(q) {
    const length = Math.hypot(...q), w = Math.min(1, Math.max(-1, q[3] / length));
    const sine = Math.sqrt(Math.max(0, 1 - w * w));
    return sine < 1e-10 ? [0, 0, 1, 0] : [q[0] / length / sine, q[1] / length / sine, q[2] / length / sine, 2 * Math.acos(w)];
}

// The admitted Transform vocabulary has translation/rotation only: R^-1 = R^T.
function inverseRigidTransform(m) {
    const inverse = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
    const p = transformPoint(inverse, [-m[12], -m[13], -m[14]]);
    inverse.splice(12, 3, ...p);
    return inverse;
}

function interpolateQuaternion(a, b, fraction) {
    let dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    if (dot < 0) { b = b.map((v) => -v); dot = -dot; }
    if (dot > 0.9995) {
        const q = a.map((v, i) => v + (b[i] - v) * fraction), norm = Math.hypot(...q);
        return q.map((v) => v / norm);
    }
    const angle = Math.acos(Math.min(1, dot)), sine = Math.sin(angle);
    return a.map((v, i) => (v * Math.sin((1 - fraction) * angle) + b[i] * Math.sin(fraction * angle)) / sine);
}

function segmentBoxInterval(start, end, center, size) {
    let enter = 0, exit = 1;
    for (let axis = 0; axis < 3; axis++) {
        const low = center[axis] - size[axis] / 2, high = center[axis] + size[axis] / 2;
        const delta = end[axis] - start[axis];
        if (Math.abs(delta) < 1e-14) {
            if (start[axis] < low || start[axis] > high) return null;
        } else {
            const a = (low - start[axis]) / delta, b = (high - start[axis]) / delta;
            enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
            if (enter > exit) return null;
        }
    }
    return [enter, exit];
}

/**
 * Host-driven semantic instance. Time is seconds, coordinates are metres.
 * step returns events and optional Lab portal intents; it performs no I/O.
 * portalBindings explicitly associate DEF names, outside X3D event semantics.
 * Intents require an allowedAnchors host allowlist (visible and accessible).
 * cancel invalidates old generations and resets history; dispose is terminal.
 * @param {object} document An immutable parseX3dDocument result.
 * @param {{portalBindings?: Array<{sensor: string, anchor: string}>}} options
 * @returns {object}
 */
export function createX3dRuntime(document, { portalBindings = [] } = {}) {
    if (!isX3dDocument(document)) throw new TypeError("runtime: expected a validated X3D document");
    const sensors = [], viewpoints = [], anchors = new Map(), placements = new Map();
    let count = 0;
    const visit = (node, parentMatrix, instance) => {
        if (++count > 20000) throw new TypeError("runtime: instance limit");
        const matrix = node.type === "Transform" ? multiplyMat4(parentMatrix,
            composeTRS(node.fields.translation, rotationQuaternion(node.fields.rotation), [1, 1, 1])) : parentMatrix;
        if (node.type === "ProximitySensor") {
            if (sensors.some((s) => s.node === node)) throw new TypeError(`${node.path}: multiply instanced ProximitySensor is unsupported`);
            sensors.push({ node, instance, inverse: inverseRigidTransform(matrix), active: false, previous: null, enabled: node.fields.enabled, position: null, orientation: null });
        }
        if (node.type === "Anchor") {
            anchors.set(node.id, node);
            if (node.def) anchors.set(node.def, node);
        }
        if (node.type === "Viewpoint") {
            const pose = multiplyMat4(matrix, composeTRS(node.fields.position, rotationQuaternion(node.fields.orientation), [1, 1, 1]));
            viewpoints.push({ id: node.id, instance, description: node.fields.description, position: transformPoint(pose, [0, 0, 0]), orientation: quaternionRotation(decomposeTRS(pose).quaternion), fieldOfView: node.fields.fieldOfView, centerOfRotation: transformPoint(matrix, node.fields.centerOfRotation) });
        }
        placements.set(instance, matrix);
        for (const [i, child] of (node.children.children ?? []).entries()) visit(child, matrix, `${instance}/${i}`);
    };
    document.roots.forEach((node, i) => visit(node, IDENTITY_MAT4, `${i}`));
    const bindings = new Map();
    if (!Array.isArray(portalBindings)) throw new TypeError("portalBindings: expected array");
    for (const binding of portalBindings) {
        const sensor = sensors.find((s) => s.node.def === binding?.sensor), anchor = anchors.get(binding?.anchor);
        if (!sensor || !anchor || bindings.has(sensor)) throw new TypeError("portalBindings: expected unique sensor and existing Anchor DEF names");
        bindings.set(sensor, anchor);
    }
    let disposed = false, generation = 0, sequence = 0, lastTime = null;
    const ensureLive = () => { if (disposed) throw new Error("runtime is disposed"); };
    const intent = (anchor, via, time) => sealX3dValue({ kind: "anchor", anchorId: anchor.id, via, time, generation, sequence: ++sequence,
        urls: [...anchor.fields.url], parameters: [...anchor.fields.parameter], description: anchor.fields.description, metadata: anchor.children.metadata });
    const allowedSet = (list) => {
        validateX3dField("strings", list, "allowedAnchors");
        if (!list.every((name) => anchors.has(name))) throw new TypeError("allowedAnchors: expected known Anchor IDs or DEF names");
        return new Set(list.map((name) => anchors.get(name)));
    };
    const reset = () => {
        generation++;
        lastTime = null;
        for (const sensor of sensors) Object.assign(sensor, { active: false, previous: null, enabled: sensor.node.fields.enabled, position: null, orientation: null });
    };
    return Object.freeze({
        viewpoints: sealX3dValue(viewpoints),
        navigation: sealX3dValue(document.nodes.filter((n) => n.type === "NavigationInfo").map((n) => n.fields)),
        get generation() { return generation; },
        isCurrent(value) { return !disposed && value === generation; },
        // Matrix copies never expose mutable runtime storage or backend handles.
        matrixOf(instance) { ensureLive(); const matrix = placements.get(instance); if (!matrix) throw new TypeError("unknown instance"); return [...matrix]; },
        step({ time, position, orientation = [0, 0, 1, 0], sensorEnabled = {}, allowedAnchors = [], paused = false }) {
            ensureLive();
            if (!Number.isFinite(time) || (lastTime !== null && time < lastTime)) throw new TypeError("time: expected monotonic finite seconds");
            validateX3dField("vec3", position, "viewer.position");
            validateX3dField("rotation", orientation, "viewer.orientation");
            if (typeof paused !== "boolean") throw new TypeError("paused: expected boolean");
            if (!sensorEnabled || typeof sensorEnabled !== "object" || Array.isArray(sensorEnabled)) throw new TypeError("sensorEnabled: expected object");
            for (const [name, value] of Object.entries(sensorEnabled)) {
                if (!sensors.some((s) => s.node.def === name || s.node.id === name) || typeof value !== "boolean") throw new TypeError(`sensorEnabled.${name}: expected known sensor and boolean`);
            }
            const allowed = allowedSet(allowedAnchors), events = [], intents = [];
            if (paused) {
                // A resumed host frame starts a new segment, never sweeps the paused gap.
                for (const sensor of sensors) sensor.previous = null;
                lastTime = time;
                return sealX3dValue({ events, intents, generation });
            }
            const viewerQuaternion = rotationQuaternion(orientation);
            for (const sensor of sensors) {
                const { node, inverse } = sensor, { center, size } = node.fields;
                const current = { time, position: transformPoint(inverse, position), quaternion: decomposeTRS(multiplyMat4(inverse, composeTRS([0, 0, 0], viewerQuaternion, [1, 1, 1]))).quaternion };
                const enabled = Object.hasOwn(sensorEnabled, node.def) ? sensorEnabled[node.def]
                    : Object.hasOwn(sensorEnabled, node.id) ? sensorEnabled[node.id] : node.fields.enabled;
                const usable = enabled && size.every((n) => n > 0);
                const inside = usable && current.position.every((v, axis) => Math.abs(v - center[axis]) <= size[axis] / 2 + 1e-12);
                const emit = (field, value, when) => events.push({ nodeId: node.id, instance: sensor.instance, field, value, time: when });
                const sample = (at) => {
                    for (const [field, key, value] of [["position_changed", "position", at.position], ["orientation_changed", "orientation", quaternionRotation(at.quaternion)]]) {
                        if (!sensor[key] || value.some((v, i) => Math.abs(v - sensor[key][i]) > 1e-10)) { emit(field, value, at.time); sensor[key] = value; }
                    }
                };
                const transition = (active, at) => {
                    sensor.active = active;
                    emit("isActive", active, at.time); emit(active ? "enterTime" : "exitTime", at.time, at.time);
                    if (active) {
                        sensor.position = sensor.orientation = null;
                        sample(at);
                        const anchor = bindings.get(sensor);
                        if (anchor && allowed.has(anchor)) intents.push(intent(anchor, "proximity", at.time));
                    }
                };
                const previous = sensor.enabled && usable ? sensor.previous : null;
                const interval = previous ? segmentBoxInterval(previous.position, current.position, center, size) : null;
                const atFraction = (f) => ({ time: previous.time + (time - previous.time) * f,
                    position: previous.position.map((v, i) => v + (current.position[i] - v) * f),
                    quaternion: interpolateQuaternion(previous.quaternion, current.quaternion, f) });
                if (!usable) {
                    if (sensor.active) transition(false, current);
                } else if (!previous) {
                    if (sensor.active !== inside) transition(inside, current);
                    if (inside) sample(current);
                } else {
                    if (!sensor.active && interval && (inside || interval[1] > interval[0])) transition(true, atFraction(interval[0]));
                    if (sensor.active && !inside) transition(false, interval ? atFraction(interval[1]) : current);
                    if (inside) sample(current);
                }
                sensor.previous = usable ? current : null;
                sensor.enabled = enabled;
            }
            lastTime = time;
            return sealX3dValue({ events, intents, generation });
        },
        activate(anchorId, { time, allowedAnchors = [] } = {}) {
            ensureLive();
            if (!Number.isFinite(time) || (lastTime !== null && time < lastTime)) throw new TypeError("time: expected monotonic finite seconds");
            const anchor = anchors.get(anchorId);
            if (!anchor) throw new TypeError("unknown Anchor");
            const permitted = allowedSet(allowedAnchors).has(anchor);
            lastTime = time;
            return permitted ? intent(anchor, "activate", time) : null;
        },
        cancel() { ensureLive(); reset(); return generation; },
        dispose() { if (disposed) return false; reset(); disposed = true; return true; },
    });
}
