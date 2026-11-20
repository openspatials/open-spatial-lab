// The glTF importer's file reader (docs/engine/SCENE-CONTRACT-V0.md, section 4): a .glb or .gltf source into its JSON
// and its buffers, and an accessor into a plain number array. It fetches nothing: a linked file comes through the
// application's `resolve`. It imports no drawing code.

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const COMPONENTS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NORMALIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const asBytes = (value, what) => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError(`${what}: expected bytes`);
};

/** True when the bytes are a binary glTF container. */
export function isGlb(bytes) {
    return bytes instanceof Uint8Array && bytes.byteLength >= 12 && new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(0, true) === GLB_MAGIC;
}

function readGlb(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(4, true), length = view.getUint32(8, true);
    if (version !== 2) throw new TypeError(`glb: container version ${version} is not 2`);
    if (length > bytes.byteLength) throw new TypeError("glb: the file is shorter than its header says");
    let offset = 12, json = null, bin = null;
    while (offset + 8 <= length) {
        const chunkLength = view.getUint32(offset, true), chunkType = view.getUint32(offset + 4, true);
        const start = offset + 8, end = start + chunkLength;
        if (end > length) throw new TypeError(`glb: chunk at byte ${offset} runs past the end`);
        if (chunkType === JSON_CHUNK && json === null) json = new TextDecoder().decode(bytes.subarray(start, end));
        else if (chunkType === BIN_CHUNK && bin === null) bin = bytes.slice(start, end);
        offset = end;
    }
    if (json === null) throw new TypeError("glb: no JSON chunk");
    return { text: json, bin };
}

/** The bytes of a data: URI. Decoding inline data is not a fetch. */
function dataUri(uri, what) {
    const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(uri);
    if (!match) throw new TypeError(`${what}: malformed data URI`);
    if (!match[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(match[3])), mimeType: match[1] || null };
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mimeType: match[1] || null };
}

/** The bytes a uri names: inline data, or a linked file through the application's resolve. */
export async function linkedBytes(uri, { resolve, signal, base, what }) {
    if (uri.startsWith("data:")) return dataUri(uri, what);
    if (typeof resolve !== "function") throw new TypeError(`${what}: the linked file ${JSON.stringify(uri)} needs the application's resolve; the importer never fetches`);
    // Relative to the source's own address: an absolute URL, a path, or nothing.
    let target = uri;
    if (base) { try { target = new URL(uri, base).href; } catch { if (base.includes("/")) target = base.slice(0, base.lastIndexOf("/") + 1) + uri; } }
    const bytes = asBytes(await resolve(target, { signal }), what);
    signal?.throwIfAborted();
    return { bytes, mimeType: null };
}

/**
 * Reads the container: the JSON and every buffer as bytes.
 * @param {{uri?: string, text?: string, bytes?: Uint8Array|ArrayBuffer}} source
 * @returns {Promise<{json: object, buffers: Uint8Array[], container: "glb"|"gltf"}>}
 */
export async function readContainer(source, { resolve, signal } = {}) {
    let text = typeof source?.text === "string" ? source.text : null, bin = null, container = "gltf";
    if (text === null) {
        if (source?.bytes == null) throw new TypeError("glTF importer: the source has neither text nor bytes");
        const bytes = asBytes(source.bytes, "source");
        if (isGlb(bytes)) { ({ text, bin } = readGlb(bytes)); container = "glb"; }
        else text = new TextDecoder().decode(bytes);
    }
    let json;
    try { json = JSON.parse(text); } catch (error) { throw new TypeError(`glTF importer: the JSON does not parse (${error.message})`); }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new TypeError("glTF importer: expected a JSON object");
    const version = String(json.asset?.version ?? "");
    if (!/^2\.\d+$/.test(version)) throw new TypeError(`asset.version: ${JSON.stringify(json.asset?.version)} is not glTF 2.x`);
    if (json.asset.minVersion !== undefined && json.asset.minVersion !== "2.0") throw new TypeError(`asset.minVersion: ${json.asset.minVersion} is newer than 2.0`);
    const buffers = [];
    for (const [i, buffer] of (json.buffers ?? []).entries()) {
        signal?.throwIfAborted();
        const what = `buffers/${i}`;
        let bytes;
        if (buffer.uri === undefined) {
            if (i !== 0 || container !== "glb" || bin === null) throw new TypeError(`${what}: no uri and no binary chunk`);
            bytes = bin;
        } else bytes = (await linkedBytes(buffer.uri, { resolve, signal, base: source.uri, what })).bytes;
        if (bytes.byteLength < buffer.byteLength) throw new TypeError(`${what}: ${bytes.byteLength} bytes, fewer than the declared ${buffer.byteLength}`);
        buffers.push(bytes);
    }
    return { json, buffers, container };
}

/** The bytes of one bufferView, as a view into its buffer. */
export function bufferViewBytes(json, buffers, index) {
    const view = json.bufferViews?.[index];
    if (!view) throw new TypeError(`bufferViews/${index}: missing`);
    const buffer = buffers[view.buffer];
    const start = view.byteOffset ?? 0, end = start + view.byteLength;
    if (!buffer || end > buffer.byteLength) throw new TypeError(`bufferViews/${index}: outside its buffer`);
    return buffer.subarray(start, end);
}

function copyElements(json, buffers, viewIndex, byteOffset, Component, itemSize, count, stride, what) {
    const out = new Component(count * itemSize);
    if (viewIndex === undefined) return out;
    const bytes = bufferViewBytes(json, buffers, viewIndex);
    const size = Component.BYTES_PER_ELEMENT, element = itemSize * size, step = stride || element;
    if (count > 0 && byteOffset + (count - 1) * step + element > bytes.byteLength) throw new TypeError(`${what}: outside its bufferView`);
    if (step === element) {
        out.set(new Component(bytes.slice(byteOffset, byteOffset + count * element).buffer));
        return out;
    }
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const read = { 1: (o) => (Component === Int8Array ? data.getInt8(o) : data.getUint8(o)), 2: (o) => (Component === Int16Array ? data.getInt16(o, true) : data.getUint16(o, true)),
        4: (o) => (Component === Float32Array ? data.getFloat32(o, true) : data.getUint32(o, true)) }[size];
    for (let i = 0; i < count; i++) for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = read(byteOffset + i * step + k * size);
    return out;
}

/**
 * One accessor as a number array of its own component type, with sparse values applied.
 * @returns {{array: ArrayLike<number>, itemSize: number, count: number, normalized: boolean, componentType: number}}
 */
export function accessorArray(json, buffers, index) {
    const what = `accessors/${index}`, accessor = json.accessors?.[index];
    if (!accessor) throw new TypeError(`${what}: missing`);
    const Component = COMPONENTS[accessor.componentType], itemSize = SIZES[accessor.type];
    if (!Component || !itemSize) throw new TypeError(`${what}: unknown componentType or type`);
    if (itemSize > 4 && Component.BYTES_PER_ELEMENT < 4) throw new TypeError(`${what}: padded matrix columns are not read`);
    const view = accessor.bufferView === undefined ? null : json.bufferViews?.[accessor.bufferView];
    const array = copyElements(json, buffers, accessor.bufferView, accessor.byteOffset ?? 0, Component, itemSize, accessor.count, view?.byteStride, what);
    if (accessor.sparse) {
        const { count, indices, values } = accessor.sparse;
        const IndexComponent = COMPONENTS[indices.componentType];
        const at = copyElements(json, buffers, indices.bufferView, indices.byteOffset ?? 0, IndexComponent, 1, count, 0, `${what}/sparse/indices`);
        const replaced = copyElements(json, buffers, values.bufferView, values.byteOffset ?? 0, Component, itemSize, count, 0, `${what}/sparse/values`);
        for (let i = 0; i < count; i++) {
            if (at[i] >= accessor.count) throw new TypeError(`${what}/sparse: index ${at[i]} outside the accessor`);
            for (let k = 0; k < itemSize; k++) array[at[i] * itemSize + k] = replaced[i * itemSize + k];
        }
    }
    return { array, itemSize, count: accessor.count, normalized: accessor.normalized === true, componentType: accessor.componentType };
}

/** An accessor as floats, normalized integers turned into their 0..1 or -1..1 values (glTF 2.0, section 3.11). */
export function accessorFloats(json, buffers, index) {
    const read = accessorArray(json, buffers, index);
    if (read.array instanceof Float32Array) return { ...read, array: read.array };
    const scale = read.normalized ? NORMALIZE[read.componentType] : 1;
    const array = new Float32Array(read.array.length);
    for (let i = 0; i < array.length; i++) array[i] = read.normalized ? Math.max(read.array[i] / scale, -1) : read.array[i];
    return { ...read, array };
}

/** An index accessor as Uint16Array or Uint32Array. */
export function accessorIndices(json, buffers, index) {
    const read = accessorArray(json, buffers, index);
    if (read.itemSize !== 1 || ![5121, 5123, 5125].includes(read.componentType)) throw new TypeError(`accessors/${index}: indices must be unsigned scalars`);
    return read.array instanceof Uint8Array ? Uint16Array.from(read.array) : read.array;
}
