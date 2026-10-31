// Runs John Carlson's soft-body world (web/x3d-worlds/soft-body.x3d.json) on the X3D path, under X3DOM or X_ITE.
// The world and its physics set-up are John Carlson's: public repository coderextreme/open-spatial-lab,
// commit bf12953173, web/worlds/soft-body.json and web/index.js. Apache-2.0, like the rest of the lab.
// The Bullet calls and their numbers below are ported by hand from his web/index.js. What is new in this
// file is the drawing: his page draws with three.js and WebGPU, and this one draws through X3D nodes.
//
// Neither engine has a SoftBody or Stitch node, and X3DOM has no RigidBody nodes at all. So the page takes
// RigidBodyCollection out of the copy it gives the engine, runs the collection in one Bullet soft-rigid
// world, as his page does, and moves the engine's Transform and Coordinate nodes every frame.
//
// Bullet here is the Ammo.js build inside X_ITE's RigidBodyPhysics component, already in the lab's vendor
// folder, under both engines. His page takes Ammo.js and three's addons from a CDN; those are outside his
// commit and are not used. X3D.Namespace.AmmoClass is an X_ITE internal, not a public X_ITE interface.

const X_ITE_MODULE = "./vendor/scene-core/vendor/x_ite/x_ite.min.mjs";
const X_ITE_PHYSICS = "./vendor/scene-core/vendor/x_ite/assets/components/RigidBodyPhysicsComponent.min.js";
const MARGIN = 0.05;
const MAX_STEP_S = 0.05;
const SPHERE_WIDTH_SEGMENTS = 32;
const SPHERE_HEIGHT_SEGMENTS = 16;
const ELLIPSOID_RESOLUTION = 256;
const CLOTH_SOFT_COLLISIONS = 0x11;
const MOVED_EPSILON = 1e-4;

// The Ammo module has a `then` of its own that resolves to itself, so an await on it never ends. It stays
// inside this object.
export async function loadAmmo() {
    const { default: X3D } = await import(X_ITE_MODULE);
    if (!X3D.Namespace.AmmoClass) {
        await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = X_ITE_PHYSICS;
            script.onload = resolve;
            script.onerror = () => reject(new Error("X_ITE's physics component did not load"));
            document.head.appendChild(script);
        });
    }
    const Ammo = X3D.Namespace.AmmoClass;
    if (!Ammo?.btSoftRigidDynamicsWorld) throw new Error("this Ammo build has no soft-body world");
    return { Ammo };
}

function findChild(children, type) {
    return children.find((child) => child[type]);
}

function shapeOf(bodyNode) {
    const entry = bodyNode["-geometry"]?.[0]?.CollidableShape;
    return entry?.["-shape"]?.Shape || entry?.shape?.Shape || null;
}

function axisAngleFromQuaternion(x, y, z, w) {
    const angle = 2 * Math.acos(Math.min(1, Math.max(-1, w)));
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    if (s < 1e-6) return [0, 1, 0, 0];
    return [x / s, y / s, z / s, angle];
}

function quaternionFromAxisAngle([x, y, z, angle]) {
    const length = Math.hypot(x, y, z) || 1;
    const s = Math.sin(angle / 2) / length;
    return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

// The shape his code gives a cloth: a plane of xDim by zDim vertices, standing at x = position.x, its first
// row on top. Vertex numbers match the nodes of btSoftBodyHelpers.CreatePatch, which his Stitch names.
function clothVertices(body) {
    const grid = shapeOf(body)["-geometry"].ElevationGrid;
    const columns = grid["@xDimension"], rows = grid["@zDimension"];
    const spacingX = grid["@xSpacing"], spacingZ = grid["@zSpacing"];
    const [px, py, pz] = body["@position"];
    const height = (rows - 1) * spacingZ;
    const points = [], faces = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            points.push(px, py + height - row * spacingZ, pz - column * spacingX);
        }
    }
    for (let row = 0; row < rows - 1; row += 1) {
        for (let column = 0; column < columns - 1; column += 1) {
            const a = row * columns + column, b = a + 1, c = a + columns, d = c + 1;
            faces.push(a, c, b, -1, b, c, d, -1);
        }
    }
    return { points, faces, columns, rows };
}

// three.js's SphereGeometry layout, which his code draws with, at the same segment counts.
function sphereVertices(body) {
    const radius = shapeOf(body)["-geometry"].Sphere["@radius"];
    const [px, py, pz] = body["@position"];
    const points = [], faces = [];
    const across = SPHERE_WIDTH_SEGMENTS + 1;
    for (let iy = 0; iy <= SPHERE_HEIGHT_SEGMENTS; iy += 1) {
        const v = iy / SPHERE_HEIGHT_SEGMENTS;
        for (let ix = 0; ix <= SPHERE_WIDTH_SEGMENTS; ix += 1) {
            const u = ix / SPHERE_WIDTH_SEGMENTS;
            points.push(
                px - radius * Math.cos(u * 2 * Math.PI) * Math.sin(v * Math.PI),
                py + radius * Math.cos(v * Math.PI),
                pz + radius * Math.sin(u * 2 * Math.PI) * Math.sin(v * Math.PI),
            );
        }
    }
    for (let iy = 0; iy < SPHERE_HEIGHT_SEGMENTS; iy += 1) {
        for (let ix = 0; ix < SPHERE_WIDTH_SEGMENTS; ix += 1) {
            const a = iy * across + ix + 1, b = iy * across + ix, c = (iy + 1) * across + ix, d = (iy + 1) * across + ix + 1;
            if (iy !== 0) faces.push(a, b, d, -1);
            if (iy !== SPHERE_HEIGHT_SEGMENTS - 1) faces.push(b, c, d, -1);
        }
    }
    return { points, faces, radius };
}

function boxOf(shape) {
    const geometry = shape["-geometry"];
    if (geometry?.Box) return geometry.Box["@size"] || [1, 1, 1];
    if (geometry?.Sphere) { const d = 2 * (geometry.Sphere["@radius"] || 1); return [d, d, d]; }
    if (geometry?.Cylinder) {
        const d = 2 * (geometry.Cylinder["@radius"] || 1);
        return [d, geometry.Cylinder["@height"] || 2, d];
    }
    return null;
}

// Splits the world into what the engine draws and what Bullet runs.
export function prepareWorld(json) {
    const scene = json.X3D.Scene;
    const children = scene["-children"];
    const collectionEntry = findChild(children, "RigidBodyCollection");
    if (!collectionEntry) throw new Error("the world has no RigidBodyCollection");
    const collection = collectionEntry.RigidBodyCollection;
    const drawn = children.filter((child) => child !== collectionEntry);
    const rigid = [], soft = [];
    for (const entry of collection["-bodies"]) {
        const body = entry.RigidBody || entry.SoftBody;
        const def = body["@DEF"];
        if (entry.SoftBody) {
            const geometry = shapeOf(body)?.["-geometry"];
            // His world's "Features" body names no shape. His code skips it, and so does this one.
            if (!geometry) continue;
            const mesh = geometry.ElevationGrid ? clothVertices(body) : sphereVertices(body);
            soft.push({ def, body, kind: geometry.ElevationGrid ? "cloth" : "sphere", mesh });
            drawn.push({
                Shape: {
                    "-appearance": shapeOf(body)["-appearance"],
                    "-geometry": {
                        IndexedFaceSet: {
                            "@solid": false, "@creaseAngle": 3.14, "@coordIndex": mesh.faces,
                            "-coord": { Coordinate: { "@DEF": `Soft_${def}`, "@point": mesh.points } },
                        },
                    },
                },
            });
            continue;
        }
        const shape = shapeOf(body);
        const box = boxOf(shape);
        if (!box) continue;
        rigid.push({ def, body, box, center: [0, 0, 0] });
        drawn.push({
            Transform: {
                "@DEF": `Body_${def}`,
                "@translation": body["@position"],
                ...(body["@orientation"] ? { "@rotation": body["@orientation"] } : {}),
                "-children": [{ Shape: shape }],
            },
        });
    }
    return {
        json: { X3D: { ...json.X3D, Scene: { ...scene, "-children": drawn } } },
        gravity: collection["@gravity"] || [0, -9.8, 0],
        rigid, soft, joints: collection["-joints"] || [],
    };
}

function createRigidBody(Ammo, world, { body, box, center }) {
    const mass = body["@mass"];
    const compound = new Ammo.btCompoundShape();
    const shape = new Ammo.btBoxShape(new Ammo.btVector3(box[0] * 0.5, box[1] * 0.5, box[2] * 0.5));
    shape.setMargin(MARGIN);
    const child = new Ammo.btTransform();
    child.setIdentity();
    child.setOrigin(new Ammo.btVector3(center[0], center[1], center[2]));
    compound.addChildShape(child, shape);
    Ammo.destroy(child);
    const inertia = new Ammo.btVector3(0, 0, 0);
    compound.calculateLocalInertia(mass, inertia);
    const start = new Ammo.btTransform();
    start.setIdentity();
    const position = body["@position"];
    start.setOrigin(new Ammo.btVector3(position[0], position[1], position[2]));
    if (body["@orientation"]) {
        const [x, y, z, w] = quaternionFromAxisAngle(body["@orientation"]);
        start.setRotation(new Ammo.btQuaternion(x, y, z, w));
    }
    const motion = new Ammo.btDefaultMotionState(start);
    const made = new Ammo.btRigidBody(new Ammo.btRigidBodyConstructionInfo(mass, motion, compound, inertia));
    if (mass > 0) made.setActivationState(4);
    world.addRigidBody(made, 2, -1);
    return made;
}

function createCloth(Ammo, world, { body, mesh }) {
    const vertex = (index) => new Ammo.btVector3(mesh.points[index * 3], mesh.points[index * 3 + 1], mesh.points[index * 3 + 2]);
    const made = new Ammo.btSoftBodyHelpers().CreatePatch(
        world.getWorldInfo(), vertex(0), vertex(mesh.columns - 1),
        vertex((mesh.rows - 1) * mesh.columns), vertex(mesh.rows * mesh.columns - 1),
        mesh.columns, mesh.rows, 0, true,
    );
    const config = made.get_m_cfg();
    config.set_viterations(10);
    config.set_piterations(10);
    config.set_collisions(CLOTH_SOFT_COLLISIONS);
    made.setTotalMass(body["@mass"] || 1, false);
    Ammo.castObject(made, Ammo.btCollisionObject).getCollisionShape().setMargin(MARGIN * 3);
    world.addSoftBody(made, 1, -1);
    made.setActivationState(4);
    return made;
}

function createSphere(Ammo, world, { body, mesh }) {
    const radius = mesh.radius;
    const made = new Ammo.btSoftBodyHelpers().CreateEllipsoid(
        world.getWorldInfo(), new Ammo.btVector3(0, 0, 0), new Ammo.btVector3(radius, radius, radius), ELLIPSOID_RESOLUTION,
    );
    const place = new Ammo.btTransform();
    place.setIdentity();
    const position = body["@position"];
    place.setOrigin(new Ammo.btVector3(position[0], position[1], position[2]));
    made.transform(place);
    const config = made.get_m_cfg();
    config.set_viterations(10);
    config.set_piterations(10);
    config.set_kDF(0.1);
    config.set_kDP(0.01);
    config.set_kPR(10);
    config.set_collisions(CLOTH_SOFT_COLLISIONS);
    const material = made.get_m_materials().at(0);
    material.set_m_kLST(0.15);
    material.set_m_kAST(0.1);
    material.set_m_kVST(0.1);
    made.setTotalMass(body["@mass"] || 1, false);
    Ammo.castObject(made, Ammo.btCollisionObject).getCollisionShape().setMargin(MARGIN);
    made.generateBendingConstraints(2, material);
    world.addSoftBody(made, 1, -1);
    made.setActivationState(4);
    return made;
}

function nearestNodes(nodes, points) {
    const count = nodes.size(), mapping = [];
    for (let i = 0; i < points.length / 3; i += 1) {
        let best = Infinity, bestIndex = -1;
        for (let j = 0; j < count; j += 1) {
            const at = nodes.at(j).get_m_x();
            const dx = points[i * 3] - at.x(), dy = points[i * 3 + 1] - at.y(), dz = points[i * 3 + 2] - at.z();
            const distance = dx * dx + dy * dy + dz * dz;
            if (distance < best) { best = distance; bestIndex = j; }
        }
        mapping.push(bestIndex);
    }
    return mapping;
}

// Runs the world. `sink` is what differs between engines: setPose(def, translation, rotation),
// setPoints(def, flat), readPoints(def).
export function runWorld({ Ammo }, prepared, sink) {
    const configuration = new Ammo.btSoftBodyRigidBodyCollisionConfiguration();
    const world = new Ammo.btSoftRigidDynamicsWorld(
        new Ammo.btCollisionDispatcher(configuration), new Ammo.btDbvtBroadphase(),
        new Ammo.btSequentialImpulseConstraintSolver(), configuration, new Ammo.btDefaultSoftBodySolver(),
    );
    const gravity = new Ammo.btVector3(prepared.gravity[0], prepared.gravity[1], prepared.gravity[2]);
    world.setGravity(gravity);
    world.getWorldInfo().set_m_gravity(gravity);

    const bodies = new Map();
    for (const entry of prepared.rigid) {
        bodies.set(entry.def, { ...entry, made: createRigidBody(Ammo, world, entry), last: null });
    }
    const softs = new Map();
    for (const entry of prepared.soft) {
        const made = entry.kind === "cloth" ? createCloth(Ammo, world, entry) : createSphere(Ammo, world, entry);
        const mapping = entry.kind === "cloth" ? null : nearestNodes(made.get_m_nodes(), entry.mesh.points);
        softs.set(entry.def, { ...entry, made, mapping, flat: new Array(entry.mesh.points.length) });
    }

    let hinge = null;
    for (const entry of prepared.joints) {
        if (entry.SingleAxisHingeJoint) {
            const joint = entry.SingleAxisHingeJoint;
            const first = bodies.get(joint["-body1"]?.RigidBody?.["@USE"]);
            const second = bodies.get(joint["-body2"]?.RigidBody?.["@USE"]);
            if (!first || !second) continue;
            const anchor = joint["@anchorPoint"], axis = joint["@axis"];
            const offset = (holder) => new Ammo.btVector3(
                anchor[0] - holder.body["@position"][0], anchor[1] - holder.body["@position"][1], anchor[2] - holder.body["@position"][2],
            );
            const axisVector = new Ammo.btVector3(axis[0], axis[1], axis[2]);
            hinge = new Ammo.btHingeConstraint(first.made, second.made, offset(first), offset(second), axisVector, axisVector, true);
            world.addConstraint(hinge, true);
        } else if (entry.Stitch) {
            const stitch = entry.Stitch;
            const rigid = bodies.get(stitch["-body1"]?.RigidBody?.["@USE"]);
            const soft = softs.get(stitch["-body2"]?.SoftBody?.["@USE"]);
            if (!rigid || !soft) continue;
            (stitch["@body1Index"] || []).forEach((node, index) => {
                soft.made.appendAnchor(Number(node), rigid.made, false, stitch["@weight"]?.[index] ?? 1);
            });
        }
    }

    // His keys: Q and A turn the arm's motor while held.
    let armMovement = 0;
    window.addEventListener("keydown", (event) => {
        if (event.code === "KeyQ") armMovement = 1;
        if (event.code === "KeyA") armMovement = -1;
    });
    window.addEventListener("keyup", (event) => {
        if (event.code === "KeyQ" || event.code === "KeyA") armMovement = 0;
    });

    const transform = new Ammo.btTransform();
    const status = {
        steps: 0, simSeconds: 0, keysSeen: 0, widestBallSpread: 0,
        rigidCount: bodies.size, softCount: softs.size,
    };

    const softPositions = (soft) => {
        const nodes = soft.made.get_m_nodes(), out = [];
        for (let i = 0; i < nodes.size(); i += 1) {
            const at = nodes.at(i).get_m_x();
            out.push([at.x(), at.y(), at.z()]);
        }
        return out;
    };
    const spreadOf = (positions) => {
        const c = [0, 1, 2].map((axis) => positions.reduce((sum, p) => sum + p[axis], 0) / positions.length);
        let near = Infinity, far = 0;
        for (const p of positions) {
            const r = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
            near = Math.min(near, r);
            far = Math.max(far, r);
        }
        return { centre: c, near, far };
    };

    let lastFrame = performance.now();
    const frame = (now) => {
        requestAnimationFrame(frame);
        const dt = Math.min(MAX_STEP_S, Math.max(0, (now - lastFrame) / 1000));
        lastFrame = now;
        if (hinge) hinge.enableAngularMotor(true, 0.8 * armMovement, 50);
        world.stepSimulation(dt, 10);
        status.steps += 1;
        status.simSeconds += dt;
        for (const soft of softs.values()) {
            const nodes = soft.made.get_m_nodes(), flat = soft.flat, count = flat.length / 3;
            for (let i = 0; i < count; i += 1) {
                const at = nodes.at(soft.mapping ? soft.mapping[i] : i).get_m_x();
                flat[i * 3] = at.x();
                flat[i * 3 + 1] = at.y();
                flat[i * 3 + 2] = at.z();
            }
            sink.setPoints(soft.def, flat);
            if (soft.kind === "sphere") {
                const { near, far } = spreadOf(softPositions(soft));
                status.widestBallSpread = Math.max(status.widestBallSpread, far - near);
            }
        }
        for (const body of bodies.values()) {
            if (body.body["@mass"] <= 0) continue;
            const motion = body.made.getMotionState();
            if (!motion) continue;
            motion.getWorldTransform(transform);
            const p = transform.getOrigin(), q = transform.getRotation();
            const now7 = [p.x(), p.y(), p.z(), q.x(), q.y(), q.z(), q.w()];
            if (body.last && now7.every((value, i) => Math.abs(value - body.last[i]) < MOVED_EPSILON)) continue;
            body.last = now7;
            sink.setPose(body.def, now7.slice(0, 3), axisAngleFromQuaternion(now7[3], now7[4], now7[5], now7[6]));
        }
    };
    requestAnimationFrame(frame);

    return {
        status,
        // What Bullet holds and what the engine holds, for a measurement from outside the page.
        sample() {
            const out = { steps: status.steps, simSeconds: status.simSeconds, widestBallSpread: status.widestBallSpread, soft: {}, rigid: {} };
            for (const soft of softs.values()) {
                const positions = softPositions(soft);
                const { centre, near, far } = spreadOf(positions);
                out.soft[soft.def] = { count: positions.length, positions, centre, near, far, drawn: sink.readPoints(soft.def) };
            }
            for (const body of bodies.values()) {
                if (body.body["@mass"] <= 0) continue;
                body.made.getMotionState().getWorldTransform(transform);
                const p = transform.getOrigin(), q = transform.getRotation();
                out.rigid[body.def] = { position: [p.x(), p.y(), p.z()], rotation: [q.x(), q.y(), q.z(), q.w()] };
            }
            return out;
        },
    };
}

export const SOFT_BODY_WORLD_FILE = "soft-body.x3d.json";
