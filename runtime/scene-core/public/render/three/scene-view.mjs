// The Three.js module's view of a Scene (docs/engine/SCENE-CONTRACT-V0.md, section 5). It builds Three objects from
// Scene data only, never writes the Scene and keeps no world state: everything here can be rebuilt from revision 0.
// Moved from x3d/scene-renderer.mjs, which built the same objects from an X3D document. It imports no reader.
// It draws both material models: "classic" (X3D's Material, Phong) and "pbr" (glTF's metallic-roughness, Standard),
// meshes from typed arrays, directional, point and spot lights, and textures it decodes from the Scene's image bytes.
// Movers (contract section 12): an entity with a `skin` is a body the adapter builds from the layer's `bodies` entry
// (bindSkin), posed with the entity's latest completed pose (setSkinPose) and freed once (disposeSkin). A layer whose
// entities are all movers (the application's `visitors`) is added, removed, shown and hidden in place; a change to any
// other layer rebuilds the view.

const isScene = (value) => value && typeof value === "object" && value.schema === "scene/0" && typeof value.changes === "function";
const where = (entity) => entity.source?.path ?? entity.id;
const key = (ref) => `${ref.layer}\u0000${ref.id}`;
// Entities that only carry data for other systems draw nothing.
const DATA_ONLY = ["camera", "sensor", "joint"];
// What a mover may carry besides its skin: nothing else of it is drawn.
const MOVER_ONLY = ["skin", "meaning"];
// Change kinds the view applies in place; any other kind rebuilds it.
const IN_PLACE = ["entity", "geometry", "pose", "layer-added", "layer-removed", "layer-visible"];
const isIdentity = ({ translation, rotation, scale }) => translation.every((v) => v === 0)
    && rotation[0] === 0 && rotation[1] === 0 && rotation[2] === 0 && rotation[3] === 1 && scale.every((v) => v === 1);
// glTF sampler numbers (the WebGL enums the format uses) and the five texture slots of the pbr model.
const FILTERS = { 9728: "NearestFilter", 9729: "LinearFilter", 9984: "NearestMipmapNearestFilter", 9985: "LinearMipmapNearestFilter", 9986: "NearestMipmapLinearFilter", 9987: "LinearMipmapLinearFilter" };
const WRAPS = { 33071: "ClampToEdgeWrapping", 33648: "MirroredRepeatWrapping", 10497: "RepeatWrapping" };
const SLOTS = [["baseColorTexture", "map", true], ["metallicRoughnessTexture", "metalnessMap", false], ["metallicRoughnessTexture", "roughnessMap", false],
    ["normalTexture", "normalMap", false], ["occlusionTexture", "aoMap", false], ["emissiveTexture", "emissiveMap", true]];

/**
 * Builds one view of every visible layer of a Scene. `createCanvas` is the host's canvas factory, for text.
 * The view's `root` is a Three scene; `camera` is built for the layer's arrival camera entity.
 * `root.userData.imagesReady` is a promise that settles when every texture image has been decoded (null when there
 * are none); `root.userData.notDrawn` lists what the view could not draw, with the reason.
 * @returns {{scene: object, root: object, camera: object, apply: Function, refresh: Function, dispose: Function}}
 */
export function createSceneView(adapter, scene, { createCanvas } = {}) {
    if (!isScene(scene)) throw new TypeError("Expected a Scene (scene/scene.mjs)");
    const THREE = adapter.raw, root = new THREE.Scene(), owned = new Set(), objects = new Map(), dynamic = new Map();
    // bodies: key(ref) -> { ref, asset, binding, freed }, one per drawn skinned entity.
    const bodies = new Map();
    const shown = () => scene.layers().filter((name) => scene.layer(name).visible);
    /** A layer that holds only movers and sets nothing for the view (no environment, navigation or defaults). */
    const isMoverLayer = (name) => {
        const header = scene.layer(name);
        if (header.environment?.background || header.environment?.color || header.navigation || header.defaults) return false;
        return scene.find({ layer: name }).every((ref) => {
            const components = scene.get(ref).components ?? {};
            return !!components.skin && Object.keys(components).every((component) => MOVER_ONLY.includes(component));
        });
    };
    const shownMovers = () => shown().filter(isMoverLayer);
    // The world: the shown layers that are not mover layers. A change to this list, or a world layer replaced or shown
    // again (a new header), rebuilds the view.
    const layers = shown().filter((name) => !isMoverLayer(name)), worldHeaders = layers.map((name) => scene.layer(name));
    let disposed = false, camera = null, arrival = null;
    const own = (resource) => { owned.add(resource); return resource; };
    const decoded = new Map(), textures = new Map(), pbrMaterials = new Map(), notDrawn = [];
    const dispose = () => {
        if (disposed) return false;
        disposed = true;
        const failures = [];
        for (const body of [...bodies.values()]) { try { freeBody(body); } catch (error) { failures.push(error); } }
        root.removeFromParent(); root.clear();
        for (const resource of owned) { try { resource.dispose(); } catch (error) { failures.push(error); } }
        for (const pending of decoded.values()) pending.then((bitmap) => bitmap?.close?.(), () => {});
        owned.clear(); objects.clear(); dynamic.clear(); decoded.clear(); textures.clear(); pbrMaterials.clear();
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
    /**
     * A body for a skinned entity, posed with its latest pose. It sits under the view's root: the pose's rootMatrix
     * places it in the world, so neither the entity's transform nor its layer's placement applies (contract section 12).
     */
    const buildBody = (ref) => {
        const entity = scene.get(ref), asset = scene.asset(ref.layer, "bodies", entity.components.skin.body);
        const binding = adapter.bindSkin(asset);
        if (!binding?.supported || !binding.root) {
            notDrawn.push({ layer: ref.layer, key: entity.components.skin.body, reason: `no body: ${binding?.reason ?? "the adapter built none"}` });
            return;
        }
        binding.root.userData.ref = Object.freeze({ layer: ref.layer, id: ref.id });
        bodies.set(key(ref), { ref, asset, binding, freed: false });
        root.add(binding.root);
        adapter.setSkinPose(binding, entity.components.skin.pose);
    };
    /** The latest pose of a drawn body. */
    const setPose = (ref) => {
        const body = bodies.get(key(ref));
        if (!body) return;
        adapter.setSkinPose(body.binding, scene.get(ref).components.skin.pose);
    };
    /** Frees a body once; the adapter may already have retired it (a rebuild retires every skin it holds). */
    const freeBody = (body) => {
        if (body.freed) return;
        body.freed = true;
        bodies.delete(key(body.ref));
        adapter.disposeSkin(body.binding);
    };
    /**
     * The bodies of the shown mover layers, made current: a body whose entity is gone, hidden or names another body is
     * freed; a new one is built; one whose entity and body stay is kept and posed. False when the world changed.
     */
    const reconcile = () => {
        const world = shown().filter((name) => !isMoverLayer(name));
        if (world.length !== worldHeaders.length || world.some((name, i) => scene.layer(name) !== worldHeaders[i])) return false;
        const wanted = new Map();
        for (const name of shownMovers()) for (const ref of scene.find({ component: "skin", layer: name })) wanted.set(key(ref), ref);
        for (const body of [...bodies.values()]) {
            if (layers.includes(body.ref.layer)) continue;
            const ref = wanted.get(key(body.ref));
            const keep = !!ref && scene.asset(ref.layer, "bodies", scene.get(ref).components.skin.body) === body.asset;
            if (!keep) freeBody(body);
        }
        for (const ref of wanted.values()) {
            if (bodies.has(key(ref))) setPose(ref);
            else buildBody(ref);
        }
        return true;
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
                if (!Number.isInteger(g.mode) || g.mode < 0 || g.mode > 6) throw new Error(`${geometryKey}: mode ${g.mode} is not a mesh mode`);
                const geometry = own(new THREE.BufferGeometry()), { NORMAL, TEXCOORD_0, COLOR_0 } = g.attributes;
                geometry.setAttribute("position", new THREE.Float32BufferAttribute(g.attributes.POSITION, 3));
                const count = g.attributes.POSITION.length / 3;
                if (NORMAL) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(NORMAL, 3));
                if (TEXCOORD_0) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(TEXCOORD_0, 2));
                if (COLOR_0) geometry.setAttribute("color", new THREE.Float32BufferAttribute(COLOR_0, COLOR_0.length / count));
                const indices = g.mode === 5 || g.mode === 6 ? fanOrStrip(g.indices, count, g.mode) : g.indices;
                if (indices) geometry.setIndex(Array.from(indices));
                if (!NORMAL && g.mode >= 4) geometry.computeVertexNormals();
                geometry.computeBoundingBox(); geometry.computeBoundingSphere();
                if (g.dynamic) { const list = dynamic.get(`${layer}\u0000${geometryKey}`) ?? []; list.push(geometry); dynamic.set(`${layer}\u0000${geometryKey}`, list); }
                const drawn = material.model === "pbr" ? pbrMaterial(materialKey, material, layer, { vertexColors: !!COLOR_0, flat: !NORMAL }) : materialFor(material);
                if (g.mode >= 4) return new THREE.Mesh(geometry, drawn);
                // Points and lines take the material's colour and base colour map, as glTF viewers draw them.
                const basic = own(g.mode === 0 ? new THREE.PointsMaterial({ size: 1, sizeAttenuation: false }) : new THREE.LineBasicMaterial());
                basic.color.copy(drawn.color); basic.map = drawn.map ?? null; basic.vertexColors = !!COLOR_0;
                return new (g.mode === 0 ? THREE.Points : g.mode === 1 ? THREE.LineSegments : g.mode === 2 ? THREE.LineLoop : THREE.Line)(geometry, basic);
            }
            default: throw new Error(`${geometryKey}: geometry type ${g.type} is not drawn`);
        }
        const geometry = own(adapter.createGeometry(description));
        return adapter.createMesh(geometry, material.model === "pbr" ? pbrMaterial(materialKey, material, layer, {}) : materialFor(material));
    };
    /** Triangle-strip (5) and triangle-fan (6) indices as a triangle list. */
    const fanOrStrip = (indices, count, mode) => {
        const at = (i) => (indices ? indices[i] : i), n = indices ? indices.length : count, out = [];
        for (let i = 2; i < n; i++) {
            if (mode === 6) out.push(at(0), at(i - 1), at(i));
            else if (i % 2 === 0) out.push(at(i - 2), at(i - 1), at(i));
            else out.push(at(i - 1), at(i - 2), at(i));
        }
        return out;
    };
    /** Decodes one image of the Scene once; the bytes stay as they are in the Scene. */
    const decodeImage = (layer, imageKey) => {
        const id = `${layer}\u0000${imageKey}`;
        if (!decoded.has(id)) {
            const image = scene.asset(layer, "images", imageKey);
            const pending = typeof createImageBitmap !== "function"
                ? Promise.reject(new Error("this host has no image decoder"))
                : createImageBitmap(new Blob([image.bytes], { type: image.mimeType ?? "" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
            pending.catch((error) => notDrawn.push({ layer, key: imageKey, reason: `image not decoded: ${error?.message ?? error}` }));
            decoded.set(id, pending);
        }
        return decoded.get(id);
    };
    /** A texture of the Scene in one colour space: glTF's sampler, no vertical flip (glTF's texture origin is top left). */
    const textureFor = (layer, textureKey, srgb) => {
        const id = `${layer}\u0000${textureKey}\u0000${srgb}`;
        if (textures.has(id)) return textures.get(id);
        const description = scene.asset(layer, "textures", textureKey);
        if (!description.image) { notDrawn.push({ layer, key: textureKey, reason: "the texture has no image the Scene holds" }); textures.set(id, null); return null; }
        const texture = own(new THREE.Texture());
        texture.flipY = false;
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        const { magFilter, minFilter, wrapS, wrapT } = description.sampler ?? {};
        texture.magFilter = THREE[FILTERS[magFilter]] ?? THREE.LinearFilter;
        texture.minFilter = THREE[FILTERS[minFilter]] ?? THREE.LinearMipmapLinearFilter;
        texture.wrapS = THREE[WRAPS[wrapS]] ?? THREE.RepeatWrapping;
        texture.wrapT = THREE[WRAPS[wrapT]] ?? THREE.RepeatWrapping;
        texture.name = textureKey;
        texture.userData.pending = decodeImage(layer, description.image).then((bitmap) => {
            if (disposed) return;
            texture.image = bitmap; texture.needsUpdate = true;
        }, () => {});
        textures.set(id, texture);
        return texture;
    };
    /** glTF's metallic-roughness material as a Standard material, set up the way Three.js's own glTF loader sets it up. */
    const pbrMaterial = (materialKey, description, layer, { vertexColors = false, flat = false }) => {
        const id = `${layer}\u0000${materialKey}\u0000${vertexColors}\u0000${flat}`;
        if (pbrMaterials.has(id)) return pbrMaterials.get(id);
        const [r, g, b, a] = description.baseColorFactor, linear = THREE.LinearSRGBColorSpace;
        const material = own(new THREE.MeshStandardMaterial({
            color: new THREE.Color().setRGB(r, g, b, linear), opacity: a, metalness: description.metallicFactor, roughness: description.roughnessFactor,
            emissive: new THREE.Color().setRGB(...description.emissiveFactor, linear), side: description.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
            transparent: description.alphaMode === "BLEND", vertexColors, flatShading: flat }));
        if (description.alphaMode === "BLEND") material.depthWrite = false;
        if (description.alphaMode === "MASK") material.alphaTest = description.alphaCutoff ?? 0.5;
        for (const [slot, property, srgb] of SLOTS) {
            const ref = description[slot];
            if (!ref) continue;
            if (ref.texCoord !== 0) { notDrawn.push({ layer, key: `${materialKey}/${slot}`, reason: `uses TEXCOORD_${ref.texCoord}; only TEXCOORD_0 is drawn` }); continue; }
            const texture = textureFor(layer, ref.texture, srgb);
            if (texture) material[property] = texture;
        }
        // The Scene has no tangents, so normal maps use screen-space derivatives; glTF's green channel then points the
        // other way (Three.js's glTF loader makes the same change when a file has no tangents).
        if (material.normalMap) material.normalScale.set(description.normalTexture.scale ?? 1, -(description.normalTexture.scale ?? 1));
        if (material.aoMap) material.aoMapIntensity = description.occlusionTexture.strength ?? 1;
        material.name = materialKey;
        pbrMaterials.set(id, material);
        return material;
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
        if (light.type !== "directional") throw new Error(`${where(entity)}: ${light.type} lights are drawn by nodeLight`);
        if (entity.parent !== null && light.scope !== "global") throw new Error(`${where(entity)}: subtree-scoped lighting is unsupported`);
        const directional = new THREE.DirectionalLight(new THREE.Color().fromArray(light.color), light.intensity);
        place(directional, entity.transform);
        // The direction is in the entity's frame; an X3D light's frame is its parent's (its rotation is the identity).
        directional.target.position.copy(directional.position).add(new THREE.Vector3().fromArray(light.direction).applyQuaternion(directional.quaternion));
        parent.add(register(directional, entity, layer), directional.target);
        if (light.ambientIntensity) parent.add(new THREE.AmbientLight(new THREE.Color().fromArray(light.color), light.ambientIntensity));
    };
    /**
     * A light that sits at its entity's origin and shines down the entity's local direction, inside the entity's own
     * group (glTF's KHR_lights_punctual: point and spot lights, and any light on a placed node or one with children).
     * Point and spot lights fall off with the square of distance and stop at `range`, as that extension says.
     */
    const nodeLight = (entity, into, layer) => {
        const light = entity.components.light, color = new THREE.Color().setRGB(...light.color, THREE.LinearSRGBColorSpace);
        const group = register(new THREE.Group(), entity, layer);
        place(group, entity.transform); into.add(group);
        let made;
        if (light.type === "point") made = new THREE.PointLight(color, light.intensity, light.range ?? 0, 2);
        else if (light.type === "spot") {
            const { innerConeAngle = 0, outerConeAngle = Math.PI / 4 } = light.spot ?? {};
            made = new THREE.SpotLight(color, light.intensity, light.range ?? 0, outerConeAngle, 1 - innerConeAngle / outerConeAngle, 2);
        } else if (light.type === "directional") made = new THREE.DirectionalLight(color, light.intensity);
        else throw new Error(`${where(entity)}: ${light.type} lights are not drawn by this view`);
        if (made.target) { made.target.position.fromArray(light.direction ?? [0, 0, -1]); made.add(made.target); }
        group.add(made);
        if (light.ambientIntensity) group.add(new THREE.AmbientLight(color, light.ambientIntensity));
        const shape = shapeOf(entity, layer);
        if (shape) group.add(shape);
        return group;
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
        const built = new Map([[null, parent]]), refs = scene.find({ layer });
        // An entity that others name as their parent needs an object of its own, so its children sit in its frame.
        const parents = new Set(refs.map((ref) => scene.get(ref).parent).filter((id) => id !== null));
        for (const ref of refs) {
            const entity = scene.get(ref), components = entity.components ?? {};
            const into = built.get(entity.parent) ?? parent;
            if (components.camera?.arrival && !arrival) arrival = ref;
            if (components.skin) { buildBody(ref); built.set(entity.id, into); continue; }
            if (DATA_ONLY.some((name) => components[name]) && !components.mesh && !components.text && !components.light && !parents.has(entity.id)) { built.set(entity.id, into); continue; }
            if (components.light && (components.light.type !== "directional" || components.mesh || components.text || parents.has(entity.id) || !isIdentity(entity.transform))) {
                built.set(entity.id, nodeLight(entity, into, layer)); continue;
            }
            if (components.light) { addLight(entity, into, layer); built.set(entity.id, into); continue; }
            const shape = shapeOf(entity, layer);
            if (shape) { place(shape, entity.transform); into.add(register(shape, entity, layer)); built.set(entity.id, shape); continue; }
            const group = register(new THREE.Group(), entity, layer);
            place(group, entity.transform); into.add(group); built.set(entity.id, group);
        }
        return header;
    };
    let navigation = null, fallback = null;
    try {
        // What the author wrote comes first; layer.defaults holds what the application supplied (contract 11, item 6).
        for (const layer of layers) {
            const header = buildLayer(layer);
            navigation ??= header.navigation ?? header.defaults?.navigation ?? null;
            fallback ??= header.defaults?.camera ?? null;
        }
        reconcile();
        // The camera for the arrival camera entity, else the layer's default camera; the application moves it.
        // znear and zfar are in the camera entity's own frame (contract 11, item 7): the entity's world scale applies.
        // A null zfar means no far limit; the view then chooses 1000 (in world units) and records it in lens.farChosen.
        const lens = arrival ? scene.get(arrival).components.camera : fallback;
        const pose = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
        if (arrival) pose.fromArray(scene.worldMatrix(arrival)).decompose(position, quaternion, scale);
        else if (fallback) { position.fromArray(fallback.position); quaternion.fromArray(fallback.rotation ?? [0, 0, 0, 1]); }
        const worldScale = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3;
        const farChosen = lens ? lens.zfar == null : true;
        const near = (lens?.znear ?? 0.1) * (lens ? worldScale : 1), far = farChosen ? 1000 : lens.zfar * worldScale;
        camera = adapter.createPerspectiveCamera({ fov: (lens?.yfov ?? Math.PI / 4) * 180 / Math.PI, aspect: 1, near, far });
        camera.userData.lens = Object.freeze({ near, far, farChosen, worldScale, from: arrival ? "entity" : fallback ? "defaults" : "none" });
        if (arrival || fallback) { camera.position.copy(position); camera.quaternion.copy(quaternion); }
        if (navigation?.headlight) {
            const headlight = new THREE.DirectionalLight(0xffffff, 1);
            headlight.target.position.set(0, 0, -1); camera.add(headlight, headlight.target); root.add(camera);
        }
        root.updateMatrixWorld(true);
        const pending = [...textures.values()].filter(Boolean).map((texture) => texture.userData.pending);
        root.userData.imagesReady = pending.length ? Promise.all(pending).then(() => undefined) : null;
        root.userData.notDrawn = notDrawn;
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
        /**
         * Applies entity, geometry and pose changes, and the adding, removing, showing and hiding of mover layers, in
         * place; false when the world's layer stack changed (or an unknown change came) and the view must be rebuilt.
         */
        apply(changes) {
            alive();
            if (changes.some((change) => !IN_PLACE.includes(change.kind))) return false;
            if (changes.some((change) => change.kind.startsWith("layer-")) && !reconcile()) return false;
            const transforms = new Map(), geometries = new Set(), poses = new Map();
            for (const change of changes) {
                if (change.kind === "pose") { poses.set(key(change.ref), change.ref); continue; }
                if (!layers.includes(change.ref.layer)) continue;
                if (change.kind === "entity") transforms.set(key(change.ref), change.ref);
                else if (change.kind === "geometry") geometries.add(key(change.ref));
            }
            for (const ref of transforms.values()) setTransform(ref);
            for (const geometryKey of geometries) setPoints(geometryKey);
            for (const ref of poses.values()) setPose(ref);
            return true;
        },
        /** Re-reads every transform, dynamic geometry and pose, for a Scene whose change log no longer reaches this view. */
        refresh() {
            alive();
            if (!reconcile()) return false;
            for (const layer of layers) for (const ref of scene.find({ layer })) setTransform(ref);
            for (const geometryKey of dynamic.keys()) setPoints(geometryKey);
            for (const body of bodies.values()) setPose(body.ref);
            return true;
        },
        dispose,
    };
}
