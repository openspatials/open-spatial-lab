// Physics adapted from web/soft-body-world.mjs and John Carlson's
// coderextreme/open-spatial-lab, commit bf12953173, web/index.js (Apache-2.0).
// Uses injected Ammo/Bullet; no renderer, loading, input listeners or frame loop.
// Physics part of the engine (moved from x3d/soft-body.mjs; step logic unchanged).
// Rigid shapes retain the source's compound-box approximation, including spheres
// and cylinders. Cloth vertex order, stitch indices and sphere nearest-node
// mapping retain that source's behavior; this is a finite compatibility layer.

import { validateField } from "../../scene/check.mjs";

const MARGIN = 0.05;
const MAX_STEP_S = 0.05;
const MOVED_EPSILON = 1e-4;

function validatePrepared(prepared) {
    const fail = (path) => { throw new TypeError(`Invalid physics data: ${path}`); };
    const vector = (value, size, path) => {
        if (!Array.isArray(value) || value.length !== size || !Array.from(value).every(Number.isFinite)) fail(path);
    };
    if (!prepared || !Array.isArray(prepared.rigid) || !Array.isArray(prepared.soft)
        || !Array.isArray(prepared.joints)) fail("prepared");
    vector(prepared.gravity, 3, "gravity");
    const rigid = new Map(), soft = new Map(), defs = new Set();
    for (const [kind, entries] of [["rigid", prepared.rigid], ["soft", prepared.soft]]) {
        for (const entry of entries) {
            const { def, body } = entry || {};
            if (typeof def !== "string" || !def.trim() || defs.has(def)) fail(`${kind}.def`);
            defs.add(def);
            if (!body || body["@DEF"] !== def || !Number.isFinite(body["@mass"]) || body["@mass"] < 0) fail(`${def}.body`);
            vector(body["@position"], 3, `${def}.position`);
            if (body["@orientation"] !== undefined) {
                vector(body["@orientation"], 4, `${def}.orientation`);
                if (!Math.hypot(...body["@orientation"].slice(0, 3))) fail(`${def}.orientation.axis`);
            }
            if (kind === "rigid") {
                vector(entry.box, 3, `${def}.box`);
                vector(entry.center, 3, `${def}.center`);
                if (entry.box.some((v) => v <= 0)) fail(`${def}.box`);
                rigid.set(def, entry);
            } else {
                const mesh = entry.mesh;
                if (!mesh || !Array.isArray(mesh.points) || !mesh.points.length || mesh.points.length % 3
                    || !Array.from(mesh.points).every(Number.isFinite)) fail(`${def}.points`);
                if (entry.kind === "cloth") {
                    if (![mesh.columns, mesh.rows].every((v) => Number.isInteger(v) && v >= 2)
                        || mesh.points.length !== mesh.columns * mesh.rows * 3) fail(`${def}.grid`);
                } else if (entry.kind !== "sphere" || !Number.isFinite(mesh.radius) || mesh.radius <= 0) fail(`${def}.kind/radius`);
                soft.set(def, entry);
            }
        }
    }
    for (const entry of prepared.joints) {
        if (!entry || Object.keys(entry).length !== 1) fail("joint");
        const hinge = entry.SingleAxisHingeJoint, stitch = entry.Stitch, joint = hinge || stitch;
        if (!joint || !rigid.has(joint["-body1"]?.RigidBody?.["@USE"])) fail("joint.body1");
        if (hinge) {
            if (!rigid.has(joint["-body2"]?.RigidBody?.["@USE"])) fail("hinge.body2");
            vector(joint["@anchorPoint"], 3, "hinge.anchorPoint");
            vector(joint["@axis"], 3, "hinge.axis");
            if (!Math.hypot(...joint["@axis"])) fail("hinge.axis");
        } else {
            const target = soft.get(joint["-body2"]?.SoftBody?.["@USE"]);
            // The compatibility scene addresses cloth nodes, whose count is known
            // before allocation. Ellipsoid node indices depend on the backend.
            if (!target || target.kind !== "cloth") fail("stitch.body2");
            const indices = joint["@body1Index"] || [], weights = joint["@weight"];
            if (!Array.isArray(indices) || !Array.from(indices).every((i) => Number.isInteger(i) && i >= 0 && i < target.mesh.points.length / 3)) fail("stitch.indices");
            if (weights !== undefined && (!Array.isArray(weights) || weights.length !== indices.length
                || !Array.from(weights).every((w) => Number.isFinite(w) && w >= 0 && w <= 1))) fail("stitch.weights");
        }
    }
}

function quaternionFromAxisAngle([x, y, z, angle]) {
    const s = Math.sin(angle / 2) / Math.hypot(x, y, z);
    return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

function axisAngleFromQuaternion([x, y, z, w]) {
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    return s < 1e-6 ? [0, 1, 0, 0] : [x / s, y / s, z / s, 2 * Math.acos(Math.min(1, Math.max(-1, w)))];
}

function softPositions(made) {
    const nodes = made.get_m_nodes(), positions = [];
    for (let i = 0; i < nodes.size(); i += 1) {
        const at = nodes.at(i).get_m_x();
        positions.push([at.x(), at.y(), at.z()]);
    }
    if (!positions.length || !positions.flat().every(Number.isFinite)) throw new Error("Invalid backend soft-body nodes");
    return positions;
}

function nearestNodes(positions, points) {
    const mapping = [];
    for (let i = 0; i < points.length; i += 3) {
        let best = Infinity, bestIndex = -1;
        positions.forEach((p, j) => {
            const distance = (points[i] - p[0]) ** 2 + (points[i + 1] - p[1]) ** 2 + (points[i + 2] - p[2]) ** 2;
            if (distance < best) { best = distance; bestIndex = j; }
        });
        mapping.push(bestIndex);
    }
    return mapping;
}

function spreadOf(positions) {
    const centre = [0, 1, 2].map((axis) => positions.reduce((sum, p) => sum + p[axis], 0) / positions.length);
    const radii = positions.map((p) => Math.hypot(...p.map((v, axis) => v - centre[axis])));
    return { centre, near: Math.min(...radii), far: Math.max(...radii) };
}

/**
 * Create physics from prepareWorld-compatible data and resolved {Ammo}.
 * sink supplies setPose(def, translation, axisAngle) and setPoints(def, flat).
 * step(dt, {armMovement: -1|0|1, paused: boolean}) consumes host seconds only;
 * zero/paused steps do nothing, positive steps cap at 0.05 s (source policy).
 * snapshot() returns detached cached state, without calling Ammo or the sink.
 * dispose() removes members and destroys only allocations made here, once.
 */
export function createSoftBodyWorld({ Ammo } = {}, prepared, sink) {
    validatePrepared(prepared);
    if (!Ammo || typeof Ammo.destroy !== "function" || typeof sink?.setPose !== "function"
        || typeof sink?.setPoints !== "function") throw new TypeError("Ammo and pose/point sink required");
    // Snapshot inputs so later caller mutation cannot change construction/stepping.
    prepared = structuredClone(prepared);
    const owned = [], bodies = new Map(), softs = new Map(), constraints = [];
    let world, hinge, transform, disposed = false;
    let state = { steps: 0, simSeconds: 0, widestBallSpread: 0, rigidCount: prepared.rigid.length,
        softCount: prepared.soft.length, disposed: false, rigid: {}, soft: {} };
    const own = (object) => { owned.push(object); return object; };
    const vector = (values) => own(new Ammo.btVector3(...values));
    function dispose() {
        if (disposed) return;
        disposed = true;
        state.disposed = true;
        const errors = [];
        const attempt = (action) => { try { action(); } catch (error) { errors.push(error); } };
        if (world) {
            for (const constraint of constraints) attempt(() => world.removeConstraint(constraint));
            for (const soft of softs.values()) attempt(() => world.removeSoftBody(soft.made));
            for (const body of bodies.values()) attempt(() => world.removeRigidBody(body.made));
        }
        for (const object of owned.reverse()) attempt(() => Ammo.destroy(object));
        owned.length = 0;
        if (errors.length) throw new AggregateError(errors, "Physics cleanup failed");
    }
    const fail = (error) => {
        try { dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Physics operation and cleanup failed"); }
        throw error;
    };
    function capture() {
        const rigid = {}, soft = {};
        for (const entry of bodies.values()) {
            if (entry.body["@mass"] <= 0) continue;
            entry.made.getMotionState().getWorldTransform(transform);
            const p = transform.getOrigin(), q = transform.getRotation();
            rigid[entry.def] = { position: [p.x(), p.y(), p.z()], rotation: [q.x(), q.y(), q.z(), q.w()] };
        }
        for (const entry of softs.values()) {
            const positions = softPositions(entry.made), spread = spreadOf(positions);
            const points = entry.mapping.flatMap((i) => positions[i]);
            soft[entry.def] = { count: positions.length, positions, ...spread, points };
            if (entry.kind === "sphere") state.widestBallSpread = Math.max(state.widestBallSpread, spread.far - spread.near);
        }
        state.rigid = rigid;
        state.soft = soft;
    }
    try {
        const configuration = own(new Ammo.btSoftBodyRigidBodyCollisionConfiguration());
        const dispatcher = own(new Ammo.btCollisionDispatcher(configuration));
        const broadphase = own(new Ammo.btDbvtBroadphase());
        const solver = own(new Ammo.btSequentialImpulseConstraintSolver());
        const softSolver = own(new Ammo.btDefaultSoftBodySolver());
        world = own(new Ammo.btSoftRigidDynamicsWorld(dispatcher, broadphase, solver, configuration, softSolver));
        const gravity = vector(prepared.gravity);
        world.setGravity(gravity);
        world.getWorldInfo().set_m_gravity(gravity);
        for (const entry of prepared.rigid) {
            const { body, box, center } = entry, mass = body["@mass"];
            const compound = own(new Ammo.btCompoundShape());
            const shape = own(new Ammo.btBoxShape(vector(box.map((v) => v * 0.5))));
            shape.setMargin(MARGIN);
            const child = own(new Ammo.btTransform());
            child.setIdentity();
            child.setOrigin(vector(center));
            compound.addChildShape(child, shape);
            const inertia = vector([0, 0, 0]);
            compound.calculateLocalInertia(mass, inertia);
            const start = own(new Ammo.btTransform());
            start.setIdentity();
            start.setOrigin(vector(body["@position"]));
            if (body["@orientation"]) start.setRotation(own(new Ammo.btQuaternion(...quaternionFromAxisAngle(body["@orientation"]))));
            const motion = own(new Ammo.btDefaultMotionState(start));
            const info = own(new Ammo.btRigidBodyConstructionInfo(mass, motion, compound, inertia));
            const made = own(new Ammo.btRigidBody(info));
            bodies.set(entry.def, { ...entry, made, last: null });
            if (mass > 0) made.setActivationState(4);
            world.addRigidBody(made, 2, -1);
        }
        for (const entry of prepared.soft) {
            const helper = own(new Ammo.btSoftBodyHelpers()), { mesh, body } = entry;
            let made;
            if (entry.kind === "cloth") {
                const vertex = (i) => vector(mesh.points.slice(i * 3, i * 3 + 3));
                made = own(helper.CreatePatch(world.getWorldInfo(), vertex(0), vertex(mesh.columns - 1),
                    vertex((mesh.rows - 1) * mesh.columns), vertex(mesh.rows * mesh.columns - 1), mesh.columns, mesh.rows, 0, true));
            } else {
                made = own(helper.CreateEllipsoid(world.getWorldInfo(), vector([0, 0, 0]), vector([mesh.radius, mesh.radius, mesh.radius]), 256));
                const place = own(new Ammo.btTransform());
                place.setIdentity();
                place.setOrigin(vector(body["@position"]));
                made.transform(place);
            }
            const holder = { ...entry, made };
            softs.set(entry.def, holder);
            const config = made.get_m_cfg();
            config.set_viterations(10);
            config.set_piterations(10);
            config.set_collisions(0x11);
            if (entry.kind === "sphere") {
                config.set_kDF(0.1); config.set_kDP(0.01); config.set_kPR(10);
                const material = made.get_m_materials().at(0);
                material.set_m_kLST(0.15); material.set_m_kAST(0.1); material.set_m_kVST(0.1);
            }
            made.setTotalMass(body["@mass"] || 1, false);
            Ammo.castObject(made, Ammo.btCollisionObject).getCollisionShape().setMargin(MARGIN * (entry.kind === "cloth" ? 3 : 1));
            if (entry.kind === "sphere") made.generateBendingConstraints(2, made.get_m_materials().at(0));
            world.addSoftBody(made, 1, -1);
            made.setActivationState(4);
            const positions = softPositions(made);
            if (entry.kind === "cloth" && positions.length !== mesh.points.length / 3) throw new Error("Backend cloth node count mismatch");
            holder.mapping = entry.kind === "cloth" ? positions.map((_, i) => i) : nearestNodes(positions, mesh.points);
        }
        for (const entry of prepared.joints) {
            const joint = entry.SingleAxisHingeJoint || entry.Stitch;
            const first = bodies.get(joint["-body1"].RigidBody["@USE"]);
            if (entry.SingleAxisHingeJoint) {
                const second = bodies.get(joint["-body2"].RigidBody["@USE"]);
                const offset = (holder) => vector(joint["@anchorPoint"].map((v, i) => v - holder.body["@position"][i]));
                const axis = vector(joint["@axis"]);
                hinge = own(new Ammo.btHingeConstraint(first.made, second.made, offset(first), offset(second), axis, axis, true));
                constraints.push(hinge);
                world.addConstraint(hinge, true);
            } else {
                const soft = softs.get(joint["-body2"].SoftBody["@USE"]);
                (joint["@body1Index"] || []).forEach((node, i) => soft.made.appendAnchor(node, first.made, false, joint["@weight"]?.[i] ?? 1));
            }
        }
        transform = own(new Ammo.btTransform());
        capture();
    } catch (error) { fail(error); }
    return {
        step(dt, actions = {}) {
            if (disposed) throw new Error("Physics world is disposed");
            if (!Number.isFinite(dt) || dt < 0 || !actions || typeof actions !== "object" || Array.isArray(actions)
                || (actions.paused !== undefined && typeof actions.paused !== "boolean")
                || (actions.armMovement !== undefined && ![-1, 0, 1].includes(actions.armMovement))) throw new TypeError("Invalid physics step/action");
            if (!dt || actions.paused) return;
            try {
                const delta = Math.min(MAX_STEP_S, dt);
                if (hinge) hinge.enableAngularMotor(true, 0.8 * (actions.armMovement ?? 0), 50);
                world.stepSimulation(delta, 10);
                state.steps += 1;
                state.simSeconds += delta;
                capture();
                for (const [def, soft] of Object.entries(state.soft)) {
                    sink.setPoints(def, soft.points.slice());
                    if (disposed) return; // A sink may synchronously tear down its host.
                }
                for (const [def, pose] of Object.entries(state.rigid)) {
                    const holder = bodies.get(def), now = [...pose.position, ...pose.rotation];
                    if (holder.last && now.every((v, i) => Math.abs(v - holder.last[i]) < MOVED_EPSILON)) continue;
                    holder.last = now;
                    sink.setPose(def, pose.position.slice(), axisAngleFromQuaternion(pose.rotation));
                    if (disposed) return;
                }
            } catch (error) { fail(error); }
        },
        snapshot() { return structuredClone(state); },
        dispose,
    };
}

/**
 * The sink createSoftBodyWorld writes through, as two Scene writes (docs/engine/SCENE-CONTRACT-V0.md, section 6):
 * a rigid body's pose becomes its entity's transform, a soft body's points its dynamic geometry's POSITION. Bodies
 * are named as prepareWorld names them, by the entity's name, in one layer. The renderer picks the writes up.
 * readPoints reads the Scene back; dispose ends the sink, never the Scene.
 */
export function createSceneSink(scene, layer = "world") {
    const rigid = new Map(), soft = new Map();
    for (const ref of scene.find({ component: "body", layer })) {
        const entity = scene.get(ref), body = entity.components.body;
        if (body.type === "rigid") rigid.set(entity.name, ref);
        else if (typeof body.dynamicGeometry === "string") soft.set(entity.name, body.dynamicGeometry);
    }
    let disposed = false;
    const alive = () => { if (disposed) throw new Error("physics sink disposed"); };
    const softKey = (def) => { const key = soft.get(def); if (!key) throw new TypeError(`Unknown soft body ${def}`); return key; };
    return Object.freeze({
        setPose(def, translation, rotation) {
            alive(); validateField("vec3", translation, "body.translation"); validateField("rotation", rotation, "body.rotation");
            const ref = rigid.get(def); if (!ref) throw new TypeError(`Unknown rigid body ${def}`);
            const [x, y, z, angle] = rotation, s = Math.sin(angle / 2) / (Math.hypot(x, y, z) || 1);
            scene.write(ref, "transform", { translation, rotation: [x * s, y * s, z * s, Math.cos(angle / 2)], scale: scene.get(ref).transform.scale });
        },
        setPoints(def, points) {
            alive(); validateField("numbers", points, "soft.points");
            scene.writeGeometry(layer, softKey(def), "POSITION", points);
        },
        readPoints(def) {
            alive();
            const a = scene.asset(layer, "geometries", softKey(def)).attributes.POSITION, result = [];
            for (let i = 0; i < a.length; i += 3) result.push([a[i], a[i + 1], a[i + 2]]);
            return result;
        },
        dispose() { disposed = true; },
    });
}
