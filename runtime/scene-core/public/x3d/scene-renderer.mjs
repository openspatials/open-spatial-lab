import { isX3dDocument } from "./json-document.mjs";
import { X3D_FIELDS, validateX3dField } from "./profile.mjs";

/**
 * Realizes an admitted document into an independent Three scene. The optional
 * preparePhysics function is the existing prepareWorld export, injected by the
 * host; it supplies topology only. No physics or rendering clock runs here.
 */
export function realizeX3dScene(adapter, document, { createCanvas, preparePhysics } = {}) {
    if (!isX3dDocument(document)) throw new TypeError("Expected a validated X3D document");
    const THREE = adapter.raw, scene = new THREE.Scene(), owned = new Set(), objects = new Map(), rigid = new Map(), soft = new Map();
    let disposed = false, prepared = null, placements = 0;
    const own = (resource) => { owned.add(resource); return resource; };
    const alive = () => { if (disposed) throw new Error("X3D scene disposed"); };
    const dispose = () => {
        if (disposed) return false;
        disposed = true;
        scene.removeFromParent(); scene.clear();
        const failures = [];
        for (const resource of owned) { try { resource.dispose(); } catch (error) { failures.push(error); } }
        owned.clear(); objects.clear(); rigid.clear(); soft.clear();
        if (failures.length) throw new AggregateError(failures, "X3D scene disposal failed");
        return true;
    };
    const register = (object, node, instance, anchorId = null) => {
        object.name = node.def || node.type;
        object.userData.x3d = { nodeId: node.id, type: node.type, instance, anchorId };
        if (!objects.has(node.id)) objects.set(node.id, []);
        objects.get(node.id).push(object);
        return object;
    };
    const rotate = (object, axisAngle) => {
        const [x, y, z, angle] = axisAngle;
        object.quaternion.setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), angle);
    };
    const materialFor = (appearance, doubleSide = false) => {
        const values = appearance?.children.material?.fields ?? Object.fromEntries(Object.entries(X3D_FIELDS.Material).map(([k, v]) => [k, v.initial]));
        // Classic X3D Material uses diffuse/emissive and defaults to no specular.
        // Values are retained as linear RGB; raster/color parity is a separate check.
        const material = own(new THREE.MeshPhongMaterial({ color: new THREE.Color().fromArray(values.diffuseColor),
            emissive: new THREE.Color().fromArray(values.emissiveColor), specular: 0, shininess: 25.6,
            side: doubleSide ? THREE.DoubleSide : THREE.FrontSide }));
        material.userData.x3dAmbientIntensity = values.ambientIntensity;
        material.onBeforeCompile = (shader) => {
            shader.uniforms.x3dAmbientIntensity = { value: values.ambientIntensity };
            const chunk = THREE.ShaderChunk.lights_fragment_begin;
            const needle = "getAmbientLightIrradiance( ambientLightColor )";
            if (!chunk.includes(needle)) throw new Error("Unsupported Three ambient shader layout");
            shader.fragmentShader = "uniform float x3dAmbientIntensity;\n" + shader.fragmentShader.replace("#include <lights_fragment_begin>",
                chunk.replace(needle, `${needle} * x3dAmbientIntensity`));
        };
        material.customProgramCacheKey = () => "x3d-classic-ambient-1";
        return material;
    };
    const textMesh = (node, appearance) => {
        if (typeof createCanvas !== "function") throw new Error(`${node.path}: authored Text requires a canvas factory`);
        const style = node.children.fontStyle?.fields ?? { size: 1, justify: ["BEGIN", "FIRST"] };
        const [horizontal = "BEGIN", vertical = "FIRST"] = style.justify;
        if (horizontal === "FIRST") throw new Error(`${node.path}: FIRST horizontal justification is unsupported`);
        const canvas = createCanvas(), context = canvas?.getContext?.("2d");
        if (!context) throw new Error(`${node.path}: no 2D text context`);
        const pixels = 64, spacing = pixels, pad = 8, lines = node.fields.string;
        context.font = `${pixels}px serif`;
        const widths = lines.map((line) => context.measureText(line).width), width = Math.max(1, ...widths), height = Math.max(pixels, lines.length * spacing);
        if (!Number.isFinite(width) || width > 8192 || height > 8192) throw new Error(`${node.path}: text texture exceeds supported size`);
        canvas.width = Math.ceil(width + pad * 2); canvas.height = Math.ceil(height + pad * 2);
        context.clearRect(0, 0, canvas.width, canvas.height); context.font = `${pixels}px serif`;
        context.textBaseline = "alphabetic"; context.fillStyle = "white";
        lines.forEach((line, i) => context.fillText(line, pad + (horizontal === "MIDDLE" ? (width - widths[i]) / 2 : horizontal === "END" ? width - widths[i] : 0), pad + pixels * 0.8 + i * spacing));
        const texture = own(adapter.createCanvasTexture(canvas, { linearFilter: true }));
        const scale = style.size / pixels;
        const geometry = own(new THREE.PlaneGeometry(canvas.width * scale, canvas.height * scale));
        const left = horizontal === "MIDDLE" ? -width / 2 : horizontal === "END" ? -width : 0;
        const top = vertical === "MIDDLE" ? height / 2 : vertical === "END" ? height : vertical === "BEGIN" ? 0 : pixels * 0.8;
        geometry.translate((left + width / 2) * scale, (top - height / 2) * scale, 0);
        const material = materialFor(appearance, true);
        material.map = texture; material.emissiveMap = texture; material.transparent = true; material.alphaTest = 0.01;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.text = { lines: [...lines], size: style.size, justify: [...style.justify], baselineApproximation: "serif canvas at 64 pixels per em" };
        return mesh;
    };
    const shapeMesh = (node) => {
        const geometryNode = node.children.geometry;
        if (!geometryNode) throw new Error(`${node.path}: empty Shape cannot be realized`);
        const f = geometryNode.fields;
        if (geometryNode.type === "Text") return textMesh(geometryNode, node.children.appearance);
        let description;
        switch (geometryNode.type) {
            case "Box": description = { type: "box", width: f.size[0], height: f.size[1], depth: f.size[2] }; break;
            case "Cylinder": description = { type: "cylinder", radiusTop: f.radius, radiusBottom: f.radius, height: f.height, radialSegments: 32 }; break;
            case "Sphere": description = { type: "sphere", radius: f.radius, widthSegments: 32, heightSegments: 16 }; break;
            default: throw new Error(`${geometryNode.path}: geometry requires supported soft-body topology`);
        }
        const geometry = own(adapter.createGeometry(description)), material = materialFor(node.children.appearance);
        return adapter.createMesh(geometry, material);
    };
    const realizeBodies = (collection, parent, instance) => {
        if (parent !== scene || prepared || typeof preparePhysics !== "function") throw new Error(`${collection.path}: one root collection requires the existing prepareWorld helper`);
        prepared = preparePhysics(document.source);
        const bodies = collection.children.bodies;
        if (prepared.rigid.length + prepared.soft.length !== bodies.length) throw new Error(`${collection.path}: preparation omitted a body`);
        for (const entry of prepared.rigid) {
            const body = bodies.find((n) => n.def === entry.def && n.type === "RigidBody");
            if (!body || body.children.geometry.length !== 1 || !body.children.geometry[0].children.shape) throw new Error(`${collection.path}: unsupported rigid body ${entry.def}`);
            const group = register(new THREE.Group(), body, `${instance}/${entry.def}`);
            group.position.fromArray(body.fields.position);
            const mesh = register(shapeMesh(body.children.geometry[0].children.shape), body, `${instance}/${entry.def}/shape`);
            group.add(mesh); parent.add(group); rigid.set(entry.def, group);
        }
        for (const entry of prepared.soft) {
            const body = bodies.find((n) => n.def === entry.def && n.type === "SoftBody");
            if (!body || body.children.geometry.length !== 1) throw new Error(`${collection.path}: unsupported soft body ${entry.def}`);
            const shape = body.children.geometry[0].children.shape;
            const geometry = own(new THREE.BufferGeometry()), triangles = [];
            let face = [];
            for (const index of entry.mesh.faces) {
                if (index === -1) { if (face.length !== 3) throw new Error("Expected triangular prepared surface"); triangles.push(...face); face = []; }
                else face.push(index);
            }
            if (face.length) throw new Error("Unterminated prepared face");
            geometry.setAttribute("position", new THREE.Float32BufferAttribute(entry.mesh.points, 3));
            geometry.setIndex(triangles); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
            const material = materialFor(shape.children.appearance, true);
            const mesh = register(new THREE.Mesh(geometry, material), body, `${instance}/${entry.def}`);
            parent.add(mesh); soft.set(entry.def, mesh);
        }
    };
    const visit = (node, parent, instance, anchorId = null) => {
        if (++placements > 20000) throw new Error("X3D realization instance limit");
        const f = node.fields;
        switch (node.type) {
            case "Transform": case "Anchor": {
                const group = register(new THREE.Group(), node, instance, node.type === "Anchor" ? node.id : anchorId);
                if (node.type === "Transform") { group.position.fromArray(f.translation); rotate(group, f.rotation); }
                parent.add(group);
                node.children.children.forEach((child, i) => visit(child, group, `${instance}/${i}`, group.userData.x3d.anchorId));
                break;
            }
            case "Shape": parent.add(register(shapeMesh(node), node, instance, anchorId)); break;
            case "Background":
                if (scene.background) throw new Error("Multiple Background bindings are unsupported");
                scene.background = new THREE.Color().fromArray(f.skyColor); break;
            case "DirectionalLight": {
                if (parent !== scene && !f.global) throw new Error(`${node.path}: subtree-scoped lighting is unsupported`);
                const light = register(new THREE.DirectionalLight(new THREE.Color().fromArray(f.color), f.intensity), node, instance);
                light.position.set(0, 0, 0); light.target.position.fromArray(f.direction); parent.add(light, light.target);
                if (f.ambientIntensity) parent.add(new THREE.AmbientLight(new THREE.Color().fromArray(f.color), f.ambientIntensity));
                break;
            }
            case "EnvironmentLight":
                if (parent !== scene) throw new Error(`${node.path}: scoped environment lighting is unsupported`);
                parent.add(register(new THREE.AmbientLight(new THREE.Color().fromArray(f.color), f.ambientIntensity), node, instance)); break;
            case "RigidBodyCollection": realizeBodies(node, parent, instance); break;
            case "WorldInfo": case "Viewpoint": case "NavigationInfo": case "ProximitySensor": break; // Semantic runtime owns these.
            default: throw new Error(`${node.path}: unsupported scene realization`);
        }
    };
    try {
        document.roots.forEach((node, i) => visit(node, scene, `${i}`));
        scene.updateMatrixWorld(true);
    } catch (error) { try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "X3D construction and rollback failed"); } throw error; }
    return {
        scene, objects, preparedPhysics: prepared,
        sink: Object.freeze({
            setPose(def, translation, rotation) {
                alive(); validateX3dField("vec3", translation, "body.translation"); validateX3dField("rotation", rotation, "body.rotation");
                const object = rigid.get(def); if (!object) throw new TypeError(`Unknown rigid body ${def}`);
                object.position.fromArray(translation); rotate(object, rotation); object.updateMatrixWorld(true);
            },
            setPoints(def, points) {
                alive(); validateX3dField("numbers", points, "soft.points");
                const object = soft.get(def); if (!object) throw new TypeError(`Unknown soft body ${def}`);
                const geometry = object.geometry, attribute = geometry.attributes.position;
                if (points.length !== attribute.array.length) throw new TypeError("Soft-body vertex count changed");
                attribute.array.set(points); attribute.needsUpdate = true;
                geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
            },
            readPoints(def) {
                alive(); const mesh = soft.get(def); if (!mesh) throw new TypeError(`Unknown soft body ${def}`);
                const a = mesh.geometry.attributes.position, result = [];
                for (let i = 0; i < a.count; i++) result.push([a.getX(i), a.getY(i), a.getZ(i)]);
                return result;
            },
        }),
        dispose,
    };
}
