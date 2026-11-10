// Isolated API/lifecycle proof with a recording Ammo double, not a physics engine.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareWorld } from "../web/soft-body-world.mjs";
import { createSoftBodyWorld } from "../runtime/scene-core/public/x3d/soft-body.mjs";

const source = JSON.parse(await readFile(new URL("../web/x3d-worlds/soft-body.x3d.json", import.meta.url), "utf8"));
const sourceBefore = JSON.stringify(source);
const prepared = prepareWorld(source);
assert.equal(JSON.stringify(source), sourceBefore);
assert.equal(prepared.rigid.length, 41);
assert.equal(prepared.soft.length, 2);

function recordingAmmo({ failAt = Infinity, failMethod, failAfter, emptySphere = false } = {}) {
    const allocations = [], calls = [], memberships = { rigid: new Set(), soft: new Set(), constraints: new Set() };
    let attempts = 0, failed = false;
    function record(name, object, args) {
        assert.ok(!object?.dead, `use after destroy: ${name}`);
        calls.push({ name, object, args });
        if (!failed && name === failMethod) { failed = true; throw new Error(`injected ${name}`); }
    }
    const method = (object, name, fn = () => {}) => (...args) => {
        record(name, object, args);
        const result = fn(...args);
        if (!failed && name === failAfter) { failed = true; throw new Error(`injected after ${name}`); }
        return result;
    };
    function allocate(type) {
        attempts += 1;
        if (attempts === failAt) throw new Error(`injected allocation ${failAt}`);
        const object = { type, id: allocations.length + 1, destroyed: 0 };
        allocations.push(object);
        return object;
    }
    const coords = (values) => ({ x: () => values[0], y: () => values[1], z: () => values[2], w: () => values[3] });
    const values = (v) => [v.x(), v.y(), v.z()];
    function makeSoft(points) {
        const object = allocate("soft");
        object.points = points;
        const config = {}, material = {}, shape = {};
        for (const name of ["set_viterations", "set_piterations", "set_collisions", "set_kDF", "set_kDP", "set_kPR"]) config[name] = method(object, name);
        for (const name of ["set_m_kLST", "set_m_kAST", "set_m_kVST"]) material[name] = method(object, name);
        shape.setMargin = method(object, "soft.margin");
        object.get_m_cfg = method(object, "get_m_cfg", () => config);
        object.get_m_materials = method(object, "get_m_materials", () => ({ at: () => material }));
        object.getCollisionShape = method(object, "getCollisionShape", () => shape);
        object.get_m_nodes = method(object, "get_m_nodes", () => ({
            size: () => object.points.length,
            at: (i) => { assert.ok(object.points[i], `node ${i} exists`); return { get_m_x: () => coords(object.points[i]) }; },
        }));
        object.transform = method(object, "soft.transform", (t) => { object.points = object.points.map((p) => p.map((v, i) => v + t.position[i])); });
        for (const name of ["setTotalMass", "setActivationState", "generateBendingConstraints", "appendAnchor"]) object[name] = method(object, name);
        return object;
    }
    const Ammo = {};
    for (const name of ["btSoftBodyRigidBodyCollisionConfiguration", "btCollisionDispatcher", "btDbvtBroadphase", "btSequentialImpulseConstraintSolver", "btDefaultSoftBodySolver"]) {
        Ammo[name] = function () { return allocate(name); };
    }
    Ammo.btVector3 = function (...v) { return Object.assign(allocate("vector"), coords(v)); };
    Ammo.btQuaternion = function (...v) { return Object.assign(allocate("quaternion"), coords(v)); };
    Ammo.btTransform = function () {
        const object = allocate("transform");
        object.setIdentity = method(object, "setIdentity", () => { object.position = [0, 0, 0]; object.rotation = [0, 0, 0, 1]; });
        object.setOrigin = method(object, "setOrigin", (p) => { object.position = values(p); });
        object.setRotation = method(object, "setRotation", (q) => { object.rotation = [...values(q), q.w()]; });
        object.getOrigin = method(object, "getOrigin", () => coords(object.position));
        object.getRotation = method(object, "getRotation", () => coords(object.rotation));
        return object;
    };
    Ammo.btCompoundShape = function () {
        const object = allocate("compound");
        object.addChildShape = method(object, "addChildShape");
        object.calculateLocalInertia = method(object, "calculateLocalInertia");
        return object;
    };
    Ammo.btBoxShape = function (size) {
        const object = allocate("box"); object.size = values(size);
        object.setMargin = method(object, "box.margin"); return object;
    };
    Ammo.btDefaultMotionState = function (start) {
        const object = allocate("motion"); object.position = start.position.slice(); object.rotation = start.rotation.slice();
        object.getWorldTransform = method(object, "getWorldTransform", (out) => { out.position = object.position.slice(); out.rotation = object.rotation.slice(); });
        return object;
    };
    Ammo.btRigidBodyConstructionInfo = function (mass, motion, compound, inertia) {
        return Object.assign(allocate("info"), { mass, motion, compound, inertia });
    };
    Ammo.btRigidBody = function (info) {
        const object = Object.assign(allocate("rigid"), { info });
        object.getMotionState = method(object, "getMotionState", () => info.motion);
        object.setActivationState = method(object, "setActivationState"); return object;
    };
    Ammo.btSoftBodyHelpers = function () {
        const object = allocate("helper");
        object.CreatePatch = method(object, "CreatePatch", (_info, a, b, c, d, columns, rows, fixed, diagonals) => {
            assert.equal(fixed, 0); assert.equal(diagonals, true);
            const corners = [a, b, c, d].map(values), points = [];
            for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
                const u = column / (columns - 1), v = row / (rows - 1);
                points.push([0, 1, 2].map((i) => (1 - v) * ((1 - u) * corners[0][i] + u * corners[1][i]) + v * ((1 - u) * corners[2][i] + u * corners[3][i])));
            }
            return makeSoft(points);
        });
        object.CreateEllipsoid = method(object, "CreateEllipsoid", (_info, centre, radius, resolution) => {
            assert.deepEqual(values(centre), [0, 0, 0]); assert.equal(resolution, 256);
            return makeSoft(emptySphere ? [] : [[radius.x(), 0, 0], [-radius.x(), 0, 0], [0, radius.y(), 0], [0, -radius.y(), 0], [0, 0, radius.z()], [0, 0, -radius.z()]]);
        }); return object;
    };
    Ammo.btHingeConstraint = function (...args) {
        const object = allocate("hinge"); object.args = args;
        object.enableAngularMotor = method(object, "enableAngularMotor"); return object;
    };
    Ammo.btSoftRigidDynamicsWorld = function () {
        const object = allocate("world");
        object.setGravity = method(object, "setGravity");
        object.getWorldInfo = method(object, "getWorldInfo", () => ({ set_m_gravity: method(object, "set_m_gravity") }));
        for (const [suffix, key] of [["RigidBody", "rigid"], ["SoftBody", "soft"], ["Constraint", "constraints"]]) {
            object[`add${suffix}`] = method(object, `add${suffix}`, (body) => { memberships[key].add(body); });
            object[`remove${suffix}`] = method(object, `remove${suffix}`, (body) => { memberships[key].delete(body); });
        }
        object.stepSimulation = method(object, "stepSimulation", (dt, substeps) => {
            assert.equal(substeps, 10);
            // Deterministic movement exercises transfer only; no physical claim.
            for (const body of memberships.rigid) if (body.info.mass > 0) body.info.motion.position[1] -= dt;
            for (const body of memberships.soft) body.points.forEach((p) => { p[1] -= dt; });
        }); return object;
    };
    Ammo.castObject = (object) => object;
    Ammo.btCollisionObject = function () {};
    Ammo.destroy = (object) => {
        assert.ok(allocations.includes(object), "borrowed wrapper must never be destroyed");
        assert.equal(object.destroyed, 0, "exactly once destruction");
        assert.ok(Object.values(memberships).every((set) => !set.has(object)), "remove before destroy");
        if (object.type === "world") assert.ok(Object.values(memberships).every((set) => !set.size));
        object.destroyed += 1; object.dead = true; calls.push({ name: "destroy", object });
    };
    return { Ammo, allocations, calls, memberships,
        assertClean() { assert.ok(allocations.every((o) => o.destroyed === 1)); assert.ok(Object.values(memberships).every((set) => !set.size)); } };
}

const poses = [], meshes = [];
const sink = { setPose: (...args) => poses.push(args), setPoints: (...args) => meshes.push(args) };
const backend = recordingAmmo();
const initialInput = JSON.stringify(prepared);
const simulation = createSoftBodyWorld(backend, prepared, sink);
assert.equal(JSON.stringify(prepared), initialInput);
const initial = simulation.snapshot();
assert.equal(initial.soft.Cloth.count, 936);
assert.deepEqual(initial.soft.Cloth.points.map((v) => Math.round(v * 1e8)), prepared.soft[0].mesh.points.map((v) => Math.round(v * 1e8)));
assert.deepEqual(backend.calls.filter((c) => c.name === "appendAnchor").map((c) => c.args[0]), [0, 7, 14, 21, 28, 35]);
assert.ok(backend.calls.filter((c) => c.name === "appendAnchor").every((c) => c.args[2] === false && c.args[3] === 1));
assert.deepEqual(backend.calls.find((c) => c.name === "setGravity").args[0].y(), prepared.gravity[1]);
assert.equal(backend.calls.filter((c) => c.name === "addRigidBody").length, 41);
assert.equal(backend.calls.filter((c) => c.name === "addSoftBody").length, 2);
for (const [name, value] of [["set_viterations", 10], ["set_piterations", 10], ["set_collisions", 17], ["set_kDF", 0.1], ["set_kDP", 0.01], ["set_kPR", 10], ["set_m_kLST", 0.15], ["set_m_kAST", 0.1], ["set_m_kVST", 0.1]]) {
    assert.ok(backend.calls.some((c) => c.name === name && c.args[0] === value), name);
}
const beforePause = backend.calls.length;
simulation.step(1, { paused: true, armMovement: 1 }); simulation.step(0);
assert.equal(backend.calls.length, beforePause);
for (const [dt, actions] of [[NaN, {}], [Infinity, {}], [-1, {}], [0.1, { armMovement: 2 }], [0.1, { armMovement: null }], [0.1, { paused: 1 }]]) assert.throws(() => simulation.step(dt, actions), /Invalid/);
assert.equal(backend.calls.length, beforePause);
simulation.step(0.02, { armMovement: 1 });
assert.deepEqual(backend.calls.findLast((c) => c.name === "enableAngularMotor").args, [true, 0.8, 50]);
assert.equal(meshes.length, 2);
assert.equal(meshes[0][1].length, 2808); assert.equal(meshes[1][1].length, 1683);
assert.equal(poses.length, prepared.rigid.filter((b) => b.body["@mass"] > 0).length);
assert.ok(Math.abs(meshes[0][1][1] - (prepared.soft[0].mesh.points[1] - 0.02)) < 1e-10);
simulation.step(1, { armMovement: -1 });
assert.deepEqual(backend.calls.findLast((c) => c.name === "enableAngularMotor").args, [true, -0.8, 50]);
simulation.step(0.01);
assert.deepEqual(backend.calls.findLast((c) => c.name === "enableAngularMotor").args, [true, 0, 50]);
assert.equal(simulation.snapshot().steps, 3);
assert.ok(Math.abs(simulation.snapshot().simSeconds - 0.08) < 1e-12);
const detached = simulation.snapshot(); detached.soft.Cloth.points[0] = 999;
assert.notEqual(simulation.snapshot().soft.Cloth.points[0], 999);
const allocationCount = backend.allocations.length;
simulation.dispose(); backend.assertClean();
const afterDispose = backend.calls.length;
simulation.dispose(); assert.equal(simulation.snapshot().disposed, true);
assert.throws(() => simulation.step(0.01), /disposed/);
assert.equal(backend.calls.length, afterDispose);

const invalidCases = [
    (p) => { p.gravity[0] = NaN; },
    (p) => { delete p.gravity[0]; },
    (p) => { p.rigid[0].body["@mass"] = -1; },
    (p) => { p.rigid[0].box[0] = 0; },
    (p) => { p.soft[0].def = p.rigid[0].def; },
    (p) => { p.soft[0].mesh.rows += 1; },
    (p) => { p.soft[1].mesh.radius = Infinity; },
    (p) => { p.joints[0].SingleAxisHingeJoint["-body1"].RigidBody["@USE"] = "missing"; },
    (p) => { p.joints[1].Stitch["@body1Index"][0] = 99999; },
    (p) => { p.joints[1].Stitch["@weight"][0] = 2; },
    (p) => { p.joints.push({ Unknown: {} }); },
];
for (const mutate of invalidCases) {
    const data = structuredClone(prepared), double = recordingAmmo(); mutate(data);
    assert.throws(() => createSoftBodyWorld(double, data, sink), /Invalid physics data/);
    assert.equal(double.allocations.length, 0);
}
const failurePoints = [1, 6, 20, 100, allocationCount - 12, allocationCount];
for (const failAt of failurePoints) {
    const double = recordingAmmo({ failAt });
    assert.throws(() => createSoftBodyWorld(double, prepared, sink), /injected/); double.assertClean();
}
for (const failMethod of ["setGravity", "addRigidBody", "CreatePatch", "soft.transform", "appendAnchor", "addConstraint"]) {
    const double = recordingAmmo({ failMethod });
    assert.throws(() => createSoftBodyWorld(double, prepared, sink), /injected/); double.assertClean();
}
for (const failAfter of ["addRigidBody", "addSoftBody", "addConstraint"]) {
    const double = recordingAmmo({ failAfter });
    assert.throws(() => createSoftBodyWorld(double, prepared, sink), /injected after/); double.assertClean();
}
const empty = recordingAmmo({ emptySphere: true });
assert.throws(() => createSoftBodyWorld(empty, prepared, sink), /Invalid backend/); empty.assertClean();
for (const method of ["setPoints", "setPose"]) {
    const double = recordingAmmo(), brokenSink = { ...sink, [method]: () => { throw new Error(`sink ${method}`); } };
    const live = createSoftBodyWorld(double, prepared, brokenSink);
    assert.throws(() => live.step(0.01), /sink/); double.assertClean();
    const calls = double.calls.length; live.dispose(); live.snapshot();
    assert.throws(() => live.step(0.01), /disposed/); assert.equal(double.calls.length, calls);
}
const stepFailure = recordingAmmo({ failMethod: "stepSimulation" });
const failedSimulation = createSoftBodyWorld(stepFailure, prepared, sink);
assert.throws(() => failedSimulation.step(0.01), /injected/); stepFailure.assertClean();
const reentrant = recordingAmmo(); let reentrantSimulation, sinkCalls = 0;
reentrantSimulation = createSoftBodyWorld(reentrant, prepared, {
    setPoints() { sinkCalls += 1; reentrantSimulation.dispose(); },
    setPose() { assert.fail("no sink calls after reentrant disposal"); },
});
reentrantSimulation.step(0.01); assert.equal(sinkCalls, 1); reentrant.assertClean();
const independentA = recordingAmmo(), independentB = recordingAmmo();
const instanceA = createSoftBodyWorld(independentA, prepared, sink), instanceB = createSoftBodyWorld(independentB, prepared, sink);
instanceA.step(0.02); instanceA.dispose(); independentA.assertClean();
assert.equal(instanceB.snapshot().steps, 0);
instanceB.step(0.01); assert.equal(instanceB.snapshot().steps, 1);
instanceB.dispose(); independentB.assertClean();

console.log(JSON.stringify({ result: "PASS", proof: "injected Ammo API/lifecycle only; no physical deformation proof",
    rigid: 41, soft: 2, clothNodes: 936, allocations: allocationCount, destroyed: allocationCount,
    invalidBeforeAllocation: invalidCases.length, constructorFailurePoints: failurePoints.length,
    methodFailures: 6, membershipSideEffectFailures: 3, sinkFailures: 2, hostSteps: 3, simSeconds: simulation.snapshot().simSeconds,
    pause: "no backend calls", afterDispose: "no backend calls", realAmmo: "not executed" }, null, 2));
