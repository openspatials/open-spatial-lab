// The Three.js module's view of a Scene (docs/engine/SCENE-CONTRACT-V0.md, section 5). It builds Three objects from
// Scene data only, never writes the Scene and keeps no world state: everything here can be rebuilt from revision 0.
// Moved from x3d/scene-renderer.mjs, which built the same objects from an X3D document. It imports no reader.

const isScene = (value) => value && typeof value === "object" && value.schema === "scene/0" && typeof value.changes === "function";
const where = (entity) => entity.source?.path ?? entity.id;
const key = (ref) => `${ref.layer}\u0000${ref.id}`;
// Entities that only carry data for other systems draw nothing.
const DATA_ONLY = ["camera", "sensor", "joint"];

/**
 * Builds one view of every visible layer of a Scene. `createCanvas` is the host's canvas factory, for text.
 * The view's `root` is a Three scene; `camera` is built for the layer's arrival camera entity.
 * @returns {{scene: object, root: object, camera: object, apply: Function, refresh: Function, dispose: Function}}
 */
export function createSceneView(adapter, scene, { createCanvas } = {}) {
    if (!isScene(scene)) throw new TypeError("Expected a Scene (scene/scene.mjs)");
    const THREE = adapter.raw, root = new THREE.Scene(), owned = new Set(), objects = new Map(), dynamic = new Map();
    const layers = scene.layers().filter((name) => scene.layer(name).visible);
    let disposed = false, camera = null, arrival = null;
    const own = (resource) => { owned.add(resource); return resource; };
    const dispose = () => {
        if (disposed) return false;
        disposed = true;
        root.removeFromParent(); root.clear();
        const failures = [];
        for (const resource of owned) { try { resource.dispose(); } catch (error) { failures.push(error); } }
        owned.clear(); objects.clear(); dynamic.clear();
        if (failures.length) throw new AggregateError(failures, "X3D scene disposal failed");
        return true;
    };
    const register = (object, entity, layer) => {
        object.name = entity.name || entity.source?.type || entity.id;
        object.userData.ref = Object.freeze({ layer, id: entity.id });
        object.userData.source = entity.source ?? null;
        objects.set(key(object.userData.ref), object);
        return object;
    };
    const place = (object, { translation, rotation, scale }) => {
        object.position.fromArray(translation); object.quaternion.fromArray(rotation); object.scale.fromArray(scale);
    };
    const materialFor = (description, doubleSide = false) => {
        if (description.model !== "classic") throw new Error(`${description.model} materials are not drawn by this view yet`);
        // Classic X3D Material uses diffuse/emissive and defaults to no specular.
        // Values are retained as linear RGB; raster/color parity is a separate check.
        const material = own(new THREE.MeshPhongMaterial({ color: new THREE.Color().fromArray(description.diffuseColor),
            emissive: new THREE.Color().fromArray(description.emissiveColor), specular: new THREE.Color().fromArray(description.specularColor),
            shininess: description.shininess * 128, side: doubleSide || description.doubleSided ? THREE.DoubleSide : THREE.FrontSide }));
        material.userData.x3dAmbientIntensity = description.ambientIntensity;
        material.onBeforeCompile = (shader) => {
            shader.uniforms.x3dAmbientIntensity = { value: description.ambientIntensity };
            const chunk = THREE.ShaderChunk.lights_fragment_begin;
            const needle = "getAmbientLightIrradiance( ambientLightColor )";
            if (!chunk.includes(needle)) throw new Error("Unsupported Three ambient shader layout");
            shader.fragmentShader = "uniform float x3dAmbientIntensity;\n" + shader.fragmentShader.replace("#include <lights_fragment_begin>",
                chunk.replace(needle, `${needle} * x3dAmbientIntensity`));
        };
        material.customProgramCacheKey = () => "x3d-classic-ambient-1";
        return material;
    };
    const textMesh = (entity, layer) => {
        const text = entity.components.text;
        if (typeof createCanvas !== "function") throw new Error(`${where(entity)}: authored Text requires a canvas factory`);
        const [horizontal = "BEGIN", vertical = "FIRST"] = text.justify;
        if (horizontal === "FIRST") throw new Error(`${where(entity)}: FIRST horizontal justification is unsupported`);
        const canvas = createCanvas(), context = canvas?.getContext?.("2d");
        if (!context) throw new Error(`${where(entity)}: no 2D text context`);
        const pixels = 64, spacing = pixels, pad = 8, lines = text.string;
        context.font = `${pixels}px serif`;
        const widths = lines.map((line) => context.measureText(line).width), width = Math.max(1, ...widths), height = Math.max(pixels, lines.length * spacing);
        if (!Number.isFinite(width) || width > 8192 || height > 8192) throw new Error(`${where(entity)}: text texture exceeds supported size`);
        canvas.width = Math.ceil(width + pad * 2); canvas.height = Math.ceil(height + pad * 2);
        context.clearRect(0, 0, canvas.width, canvas.height); context.font = `${pixels}px serif`;
        context.textBaseline = "alphabetic"; context.fillStyle = "white";
        lines.forEach((line, i) => context.fillText(line, pad + (horizontal === "MIDDLE" ? (width - widths[i]) / 2 : horizontal === "END" ? width - widths[i] : 0), pad + pixels * 0.8 + i * spacing));
        const texture = own(adapter.createCanvasTexture(canvas, { linearFilter: true }));
        const scale = text.size / pixels;
        const geometry = own(new THREE.PlaneGeometry(canvas.width * scale, canvas.height * scale));
        const left = horizontal === "MIDDLE" ? -width / 2 : horizontal === "END" ? -width : 0;
        const top = vertical === "MIDDLE" ? height / 2 : vertical === "END" ? height : vertical === "BEGIN" ? 0 : pixels * 0.8;
        geometry.translate((left + width / 2) * scale, (top - height / 2) * scale, 0);
        const material = materialFor(scene.asset(layer, "materials", text.material), true);
        material.map = texture; material.emissiveMap = texture; material.transparent = true; material.alphaTest = 0.01;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.text = { lines: [...lines], size: text.size, justify: [...text.justify], baselineApproximation: "serif canvas at 64 pixels per em" };
        return mesh;
    };
    const primitiveMesh = ({ geometry: geometryKey, material: materialKey }, layer) => {
        const g = scene.asset(layer, "geometries", geometryKey), material = scene.asset(layer, "materials", materialKey);
        let description;
        switch (g.type) {
            case "box": description = { type: "box", width: g.size[0], height: g.size[1], depth: g.size[2] }; break;
            case "cylinder": description = { type: "cylinder", radiusTop: g.radius, radiusBottom: g.radius, height: g.height, radialSegments: 32 }; break;
            case "sphere": description = { type: "sphere", radius: g.radius, widthSegments: 32, heightSegments: 16 }; break;
            case "mesh": {
                if (g.mode !== 4) throw new Error(`${geometryKey}: only triangle meshes are drawn`);
                const geometry = own(new THREE.BufferGeometry());
                geometry.setAttribute("position", new THREE.Float32BufferAttribute(g.attributes.POSITION, 3));
                geometry.setIndex(Array.from(g.indices)); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
                if (g.dynamic) { const list = dynamic.get(`${layer}\u0000${geometryKey}`) ?? []; list.push(geometry); dynamic.set(`${layer}\u0000${geometryKey}`, list); }
                return new THREE.Mesh(geometry, materialFor(material));
            }
            default: throw new Error(`${geometryKey}: geometry type ${g.type} is not drawn`);
        }
        const geometry = own(adapter.createGeometry(description));
        return adapter.createMesh(geometry, materialFor(material));
    };
    const shapeOf = (entity, layer) => {
        const { mesh, text } = entity.components;
        if (text) return textMesh(entity, layer);
        if (!mesh) return null;
        if (mesh.primitives.length === 1) return primitiveMesh(mesh.primitives[0], layer);
        const group = new THREE.Group();
        for (const primitive of mesh.primitives) group.add(primitiveMesh(primitive, layer));
        return group;
    };
    const addLight = (entity, parent, layer) => {
        const light = entity.components.light;
        if (light.type !== "directional") throw new Error(`${where(entity)}: ${light.type} lights are not drawn by this view yet`);
        if (entity.parent !== null && light.scope !== "global") throw new Error(`${where(entity)}: subtree-scoped lighting is unsupported`);
        const directional = new THREE.DirectionalLight(new THREE.Color().fromArray(light.color), light.intensity);
        place(directional, entity.transform);
        directional.target.position.copy(directional.position).add(new THREE.Vector3().fromArray(light.direction));
        parent.add(register(directional, entity, layer), directional.target);
        if (light.ambientIntensity) parent.add(new THREE.AmbientLight(new THREE.Color().fromArray(light.color), light.ambientIntensity));
    };
    const buildLayer = (layer) => {
        const header = scene.layer(layer), environment = header.environment ?? {};
        let parent = root;
        const { translation, rotation, scale } = header.placement;
        if (translation.some((v) => v !== 0) || rotation[3] !== 1 || scale.some((v) => v !== 1)) {
            parent = new THREE.Group(); place(parent, header.placement); root.add(parent);
        }
        if (environment.background) {
            if (root.background) throw new Error("Multiple Background bindings are unsupported");
            root.background = new THREE.Color().fromArray(environment.background.skyColor);
        }
        if (environment.color) parent.add(new THREE.AmbientLight(new THREE.Color().fromArray(environment.color), environment.intensity));
        const built = new Map([[null, parent]]);
        for (const ref of scene.find({ layer })) {
            const entity = scene.get(ref), components = entity.components ?? {};
            const into = built.get(entity.parent) ?? parent;
            if (components.camera?.arrival && !arrival) arrival = ref;
            if (DATA_ONLY.some((name) => components[name]) && !components.mesh && !components.text && !components.light) { built.set(entity.id, into); continue; }
            if (components.light) { addLight(entity, into, layer); built.set(entity.id, into); continue; }
            const shape = shapeOf(entity, layer);
            if (shape) { place(shape, entity.transform); into.add(register(shape, entity, layer)); built.set(entity.id, shape); continue; }
            const group = register(new THREE.Group(), entity, layer);
            place(group, entity.transform); into.add(group); built.set(entity.id, group);
        }
        return header;
    };
    let navigation = null;
    try {
        for (const layer of layers) navigation ??= buildLayer(layer).navigation ?? null;
        // The camera for the arrival camera entity; the application moves it.
        const lens = arrival ? scene.get(arrival).components.camera : null;
        camera = adapter.createPerspectiveCamera({ fov: (lens?.yfov ?? Math.PI / 4) * 180 / Math.PI, aspect: 1, near: lens?.znear ?? 0.1, far: lens?.zfar ?? 1000 });
        if (arrival) new THREE.Matrix4().fromArray(scene.worldMatrix(arrival)).decompose(camera.position, camera.quaternion, new THREE.Vector3());
        if (navigation?.headlight) {
            const headlight = new THREE.DirectionalLight(0xffffff, 1);
            headlight.target.position.set(0, 0, -1); camera.add(headlight, headlight.target); root.add(camera);
        }
        root.updateMatrixWorld(true);
    } catch (error) { try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "X3D construction and rollback failed"); } throw error; }

    const alive = () => { if (disposed) throw new Error("X3D scene disposed"); };
    const setTransform = (ref) => {
        const object = objects.get(key(ref));
        if (!object) return;
        place(object, scene.get(ref).transform); object.updateMatrixWorld(true);
    };
    const setPoints = (geometryKey) => {
        const [layer, name] = geometryKey.split("\u0000"), points = scene.asset(layer, "geometries", name).attributes.POSITION;
        for (const geometry of dynamic.get(geometryKey) ?? []) {
            const attribute = geometry.attributes.position;
            if (points.length !== attribute.array.length) throw new TypeError("Soft-body vertex count changed");
            attribute.array.set(points); attribute.needsUpdate = true;
            geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
        }
    };
    return {
        scene, root, camera,
        /** Applies entity and geometry changes in place; false when the layer stack changed and the view must be rebuilt. */
        apply(changes) {
            alive();
            if (changes.some((change) => change.kind !== "entity" && change.kind !== "geometry")) return false;
            const transforms = new Map(), geometries = new Set();
            for (const change of changes) {
                if (!layers.includes(change.ref.layer)) continue;
                if (change.kind === "entity") transforms.set(key(change.ref), change.ref);
                else geometries.add(key(change.ref));
            }
            for (const ref of transforms.values()) setTransform(ref);
            for (const geometryKey of geometries) setPoints(geometryKey);
            return true;
        },
        /** Re-reads every transform and dynamic geometry, for a Scene whose change log no longer reaches this view. */
        refresh() {
            alive();
            const now = scene.layers().filter((name) => scene.layer(name).visible);
            if (now.length !== layers.length || now.some((name, i) => name !== layers[i])) return false;
            for (const layer of layers) for (const ref of scene.find({ layer })) setTransform(ref);
            for (const geometryKey of dynamic.keys()) setPoints(geometryKey);
            return true;
        },
        dispose,
    };
}
