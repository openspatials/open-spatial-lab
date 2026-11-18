// The side of the sandbox that runs inside the worker, in Node (sandbox-node.mjs) and in a browser (sandbox-web.mjs).
// It compiles the (already checked and capped) module, instantiates it with its binding, and runs one lifecycle call
// per message. It imports nothing from node:, and talks to the main thread only through `port`:
//   port.post(message)        sends one message to the main thread;
//   port.onMessage(handler)   calls handler(message) for each message from the main thread.
//
// Messages to the main thread: ready | failed | event | begin | end. The main thread arms its watchdog on "begin".
// From the main thread: a lifecycle call { id, op, args }, or { type: "grant", index, grant }, which replaces one
// attachment's grant before the next call (no begin or end).
// Memory is measured here, from the module's own memory.buffer.byteLength.
import { allows, ERRORS, grantTokens } from "./capabilities.mjs";

const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();

/** The kind of global the guest runs in: DedicatedWorkerGlobalScope in a Web Worker, Window on a page. */
const scopeName = () => Object.prototype.toString.call(globalThis).slice(8, -1);

/** Runs the guest for one extension: { bytes, bindingUrl, grant } from the main thread. */
export async function runGuest(port, { bytes, bindingUrl, grant }) {
  const tokens = grantTokens(grant);
  // Grants set while the extension runs, by attachment; an attachment without one has the first grant.
  const grants = new Map();
  const grantOf = (index) => (index !== null && index !== undefined && grants.has(index) ? grants.get(index) : tokens);
  const post = (event) => port.post({ type: "event", event });
  const fabrics = new Map();
  const nodes = new Map();
  let memory = null;
  let exports = null;
  let current = null;
  let nextIndex = 1n;

  const host = {
    memory: () => memory,
    allows: (token) => allows(grantOf(current), token),
    allowsFor: (index, token) => allows(grantOf(index), token),
    refuse(token, call, code = ERRORS.DENIED) {
      post({ kind: "refusal", token, call, result: Number(code) });
      return code;
    },
    attachment: (index) => fabrics.get(index) || null,
    log: (attachment, text) => post({ kind: "log", attachment, text }),
    createNode({ attachment, parent, class: nodeClass, index, name, reference }) {
      let objectIndex = index;
      if (objectIndex === null) {
        while ([...nodes.values()].some((node) => node.index === nextIndex)) nextIndex += 1n;
        objectIndex = nextIndex++;
      }
      const composed = (BigInt(nodeClass) << 48n) | objectIndex;
      if (nodes.has(composed)) return 0x0000fffffffffffen;
      const node = { attachment, composed, class: nodeClass, index: objectIndex, parent, name, reference };
      nodes.set(composed, node);
      post({ kind: "node", node: { ...node, composed: String(composed), index: String(objectIndex), parent: parent === null ? null : String(parent) } });
      return composed;
    },
    node: (composed) => nodes.get(BigInt.asUintN(64, composed)) || null,
    updateNode(composed, fields) {
      Object.assign(nodes.get(composed), fields);
      post({ kind: "node-update", composed: String(composed), fields });
    },
    // For a binding with its own lifecycle: the instance exports, the attachment of the running call, binding events.
    exports: () => exports,
    current: () => current,
    emit: (event) => post(event),
    removeNode(composed) {
      const gone = [composed];
      for (let at = 0; at < gone.length; at += 1) {
        for (const [child, node] of nodes) if (node.parent === gone[at] && !gone.includes(child)) gone.push(child);
      }
      for (const item of gone) nodes.delete(item);
      post({ kind: "node-remove", composed: gone.map(String) });
    },
  };

  let binding;
  try {
    binding = await import(bindingUrl);
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, binding.createImports(host));
    exports = instance.exports;
    memory = exports.memory instanceof WebAssembly.Memory ? exports.memory : null;
  } catch (error) {
    port.post({ type: "failed", error: `instantiate: ${oneLine(error)}` });
    return;
  }

  const record = (name) => post({ kind: "call", name });
  const ops = binding.lifecycle ? lifecycleOps(binding.lifecycle) : {
    init() {
      if (typeof exports._initialize === "function") {
        record("_initialize");
        exports._initialize();
      }
      record("Init");
      if (typeof exports.Init === "function") exports.Init();
    },
    open({ index, fabric, snapshot }) {
      fabrics.set(index, fabric);
      const blob = new TextEncoder().encode(snapshot);
      let offset = 0;
      if (typeof exports.Alloc === "function") {
        offset = exports.Alloc(blob.length) >>> 0;
        if (!memory || offset === 0 || offset + blob.length > memory.buffer.byteLength) throw new Error(`Alloc returned ${offset}, outside memory`);
        new Uint8Array(memory.buffer, offset, blob.length).set(blob);
      }
      record(`Open ${index}`);
      if (typeof exports.Open === "function") exports.Open(BigInt(index), offset, offset ? blob.length : 0);
      if (offset && typeof exports.Free === "function") exports.Free(offset, blob.length);
    },
    close({ index }) {
      record(`Close ${index}`);
      try {
        if (typeof exports.Close === "function") exports.Close(BigInt(index));
      } finally {
        fabrics.delete(index);
        for (const [composed, node] of nodes) if (node.attachment === index) nodes.delete(composed);
      }
    },
    shutdown() {
      record("Shutdown");
      if (typeof exports.Shutdown === "function") exports.Shutdown();
    },
  };

  // A binding's own lifecycle, in place of the RP1 defaults above. Calls that name an attachment run with it current.
  function lifecycleOps(lifecycle) {
    const context = { exports, host, record, memory: () => memory };
    const within = (index, fn) => {
      current = index;
      try {
        return fn();
      } finally {
        current = null;
      }
    };
    return {
      init: (args) => lifecycle.init(context, args),
      open(args) {
        fabrics.set(args.index, args.fabric);
        try {
          within(args.index, () => lifecycle.open(context, args));
        } catch (error) {
          fabrics.delete(args.index);
          throw error;
        }
      },
      close(args) {
        try {
          within(args.index, () => lifecycle.close(context, args));
        } finally {
          fabrics.delete(args.index);
          for (const [composed, node] of nodes) if (node.attachment === args.index) nodes.delete(composed);
        }
      },
      shutdown: (args) => lifecycle.shutdown(context, args),
      notify: (args) => within(args.index, () => lifecycle.notify(context, args)),
    };
  }

  port.onMessage(({ type, id, op, args, index, grant: next }) => {
    if (type === "grant") {
      grants.set(index, grantTokens(next));
      if (binding.lifecycle && typeof binding.lifecycle.grant === "function") binding.lifecycle.grant({ exports, host, record, memory: () => memory }, { index });
      return;
    }
    port.post({ type: "begin", id });
    let result;
    try {
      if (!ops[op]) throw new Error("unknown call");
      ops[op](args || {});
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: `${op}: ${oneLine(error)}` };
    }
    port.post({ type: "end", id, ...result, memoryBytes: memory ? memory.buffer.byteLength : 0 });
  });
  port.post({ type: "ready", exports: Object.keys(exports), scope: scopeName() });
}
