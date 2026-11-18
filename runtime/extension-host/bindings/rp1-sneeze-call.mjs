// A read-only RP1 compatibility binding: the single import Sneeze.Call (i32 offset, i32 size) -> i64.
//
// Every call is a packet in the extension's own memory: an 8-byte little-endian header (wType u16, wMethod u16,
// dwSize u32) and dwSize bytes of fields. Strings and buffers travel as (u32 offset, u32 length) pairs. The wire
// format follows include/sneeze_abi.h of SneezeSDK 44d0346fe22a (Apache-2.0) and the packet writers of
// SneezeSDK_Rust 4e7d0800f7ae (Apache-2.0). This binding answers only:
//
//   CONSOLE LOG (2,1)                      (u64 fabric, text)                 -> 0          needs ue.console.log
//   DATA HAS (1,1)                         (u64 fabric, text path)            -> 1 or 0     needs ue.data.read
//   DATA GET (1,2)                         (u64 fabric, text path, buffer)    -> byte count needs ue.data.read
//   FABRIC NODE_MAP_DATA (7,3)             (u64 fabric, text path)            -> node       needs ue.scene.nodes
//   FABRIC NODE_ROOT (7,4)                 (u64 fabric, MAPOBJECT bytes)      -> node       needs ue.scene.nodes
//   FABRIC NODE_OPEN (7,5)                 (MAPOBJECT bytes)                  -> node       needs ue.scene.nodes
//   NODE NAME (8,6), NODE RESOURCE (8,7)   (u64 node, text)                   -> 0          needs ue.scene.nodes
//
// Any other (wType, wMethod) returns ERRORS.UNKNOWN. A refused call returns ERRORS.DENIED. Lookups in the fabric's
// Data tree match keys exactly, case included.
import { ERRORS } from "../capabilities.mjs";

export const NAME = "rp1-sneeze-call";
export const INTERFACE = "rp1-sneeze-call";
/** The imports this binding defines: module name -> field names. */
export const IMPORTS = Object.freeze({ Sneeze: Object.freeze(["Call"]) });

const HEADER_SIZE = 8;
const MAPOBJECT_SIZE = 528;
const OBJECTIX_ERROR = 0x0000fffffffffffen;
const OBJECTIX_IDENTITY = 0x0000ffffffffffffn;
const INDEX_MASK = 0x0000ffffffffffffn;
const CLASS_LETTERS = Object.freeze({ R: 70, C: 71, T: 72, P: 73 });
const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

class Fault extends Error {}

const key = (type, method) => `${type}:${method}`;

/** Splits a dotted DATA path; "" addresses the whole tree. */
export function splitPath(path) {
  return path === "" ? [] : path.split(".");
}

/** The value at `segments` under `root`, with each key matched exactly. */
export function readPath(root, segments) {
  let value = root;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const name = Object.keys(value).find((name) => name === segment);
    if (name === undefined) return undefined;
    value = value[name];
  }
  return value;
}

/** A packet reader over the extension's memory, bounds-checked on every read. */
function reader(memory, offset, size) {
  const buffer = memory.buffer;
  if (offset < 0 || size < HEADER_SIZE || offset + size > buffer.byteLength) throw new Fault("packet outside memory");
  const view = new DataView(buffer, offset, size);
  const dwSize = view.getUint32(4, true);
  if (HEADER_SIZE + dwSize > size) throw new Fault("packet shorter than its header says");
  let at = HEADER_SIZE;
  const need = (count) => { if (at + count > HEADER_SIZE + dwSize) throw new Fault("packet field past its end"); };
  const span = (spanOffset, length) => {
    if (spanOffset + length > buffer.byteLength) throw new Fault("span outside memory");
    return new Uint8Array(buffer, spanOffset, length);
  };
  return {
    type: view.getUint16(0, true),
    method: view.getUint16(2, true),
    qword() { need(8); const value = view.getBigUint64(at, true); at += 8; return value; },
    pair() { need(8); const pairOffset = view.getUint32(at, true), length = view.getUint32(at + 4, true); at += 8; return span(pairOffset, length); },
    text() { return decoder.decode(this.pair()); },
  };
}

function cString(bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** The fields of a 528-byte SNEEZE_ABI_MAPOBJECT this binding reads. */
function readMapObject(bytes) {
  if (bytes.length !== MAPOBJECT_SIZE) throw new Fault("map object is not 528 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const units = [];
  for (let i = 0; i < 48; i += 1) {
    const unit = view.getUint16(24 + i * 2, true);
    if (!unit) break;
    units.push(unit);
  }
  return {
    parent: view.getBigUint64(0, true),
    self: view.getBigUint64(8, true),
    name: String.fromCharCode(...units),
    resourceName: cString(bytes.subarray(144, 208)),
    reference: cString(bytes.subarray(208, 336)),
  };
}

const classOf = (composed) => Number(composed >> 48n);
const indexOf = (composed) => composed & INDEX_MASK;

/**
 * The import object for one instance. `host` is the sandbox's side of the call:
 *   memory() -> WebAssembly.Memory        allows(token) -> boolean           refuse(token, call) -> negative bigint
 *   attachment(index) -> fabric or null   log(index, text)
 *   createNode({ attachment, class, index, parent, name, reference }) -> composed bigint
 *   node(composed) -> node or null        updateNode(composed, fields)
 */
export function createImports(host) {
  const gate = (token, call) => (host.allows(token) ? null : host.refuse(token, call));
  const fabricOf = (index) => {
    const fabric = host.attachment(Number(index));
    if (!fabric) throw new Fault(`no open attachment ${index}`);
    return fabric;
  };
  const lookup = (fabric, path) => readPath(fabric, ["Data", ...splitPath(path)]);

  // Builds one node from an MSF node description, then its aChildren, under `parent`. Returns the composed root.
  const buildFromData = (description, attachment, parent) => {
    const self = readPath(description, ["Head", "Self"]);
    const match = /^([RCTP])-(\?|\d+)$/.exec(typeof self === "string" ? self : "");
    if (!match) return { root: OBJECTIX_ERROR, count: 0 };
    const name = readPath(description, ["Name"]);
    const reference = readPath(description, ["Resource", "sReference"]);
    const root = host.createNode({
      attachment, parent, class: CLASS_LETTERS[match[1]], index: match[2] === "?" ? null : BigInt(match[2]),
      name: typeof name === "string" ? name : "", reference: typeof reference === "string" ? reference : "",
    });
    let count = 1;
    const children = readPath(description, ["aChildren"]);
    for (const child of Array.isArray(children) ? children : []) count += buildFromData(child, attachment, root).count;
    return { root, count };
  };

  const consoleLog = (packet) => {
    const index = packet.qword(), text = packet.text();
    const refused = gate("ue.console.log", "CONSOLE.LOG");
    if (refused) return refused;
    host.log(Number(index), text);
    return 0n;
  };
  const dataHas = (packet) => {
    const fabric = fabricOf(packet.qword()), path = packet.text();
    const refused = gate("ue.data.read", "DATA.HAS");
    if (refused) return refused;
    return lookup(fabric, path) === undefined ? 0n : 1n;
  };
  const dataGet = (packet) => {
    const fabric = fabricOf(packet.qword()), path = packet.text(), buffer = packet.pair();
    const refused = gate("ue.data.read", "DATA.GET");
    if (refused) return refused;
    const value = lookup(fabric, path);
    if (value === undefined || value === null) return 0n;
    const json = encoder.encode(JSON.stringify(value));
    buffer.set(json.subarray(0, Math.min(json.length, buffer.length)));
    return BigInt(json.length);
  };
  const nodeMapData = (packet) => {
    const index = packet.qword(), path = packet.text();
    const refused = gate("ue.scene.nodes", "FABRIC.NODE_MAP_DATA");
    if (refused) return refused;
    const description = lookup(fabricOf(index), path);
    if (!description || typeof description !== "object") return OBJECTIX_ERROR;
    return buildFromData(description, Number(index), null).root;
  };
  const makeNode = (object, attachment, parent) => host.createNode({
    attachment, parent, class: classOf(object.self),
    index: indexOf(object.self) === OBJECTIX_IDENTITY ? null : indexOf(object.self),
    name: object.name, reference: object.reference,
  });
  const nodeRoot = (packet) => {
    const index = packet.qword(), object = readMapObject(packet.pair());
    const refused = gate("ue.scene.nodes", "FABRIC.NODE_ROOT");
    if (refused) return refused;
    fabricOf(index);
    return makeNode(object, Number(index), null);
  };
  const nodeOpen = (packet) => {
    const object = readMapObject(packet.pair());
    const refused = gate("ue.scene.nodes", "FABRIC.NODE_OPEN");
    if (refused) return refused;
    const parent = host.node(object.parent);
    if (!parent) return ERRORS.INVALID;
    return makeNode(object, parent.attachment, object.parent);
  };
  const nodeText = (field, call) => (packet) => {
    const composed = packet.qword(), text = packet.text();
    const refused = gate("ue.scene.nodes", call);
    if (refused) return refused;
    if (!host.node(composed)) return ERRORS.INVALID;
    host.updateNode(composed, { [field]: text });
    return 0n;
  };

  const METHODS = {
    [key(2, 1)]: consoleLog,
    [key(1, 1)]: dataHas,
    [key(1, 2)]: dataGet,
    [key(7, 3)]: nodeMapData,
    [key(7, 4)]: nodeRoot,
    [key(7, 5)]: nodeOpen,
    [key(8, 6)]: nodeText("name", "NODE.NAME"),
    [key(8, 7)]: nodeText("reference", "NODE.RESOURCE"),
  };

  return {
    Sneeze: {
      Call(offset, size) {
        try {
          const packet = reader(host.memory(), offset >>> 0, size >>> 0);
          const method = METHODS[key(packet.type, packet.method)];
          return method ? method(packet) : ERRORS.UNKNOWN;
        } catch (error) {
          if (error instanceof Fault) return ERRORS.FAULT;
          throw error;
        }
      },
    },
  };
}
