// The browser adapter of the sandbox: one module Web Worker per extension, and the page's watchdog that ends it when a
// call runs over budget. Imported on the page it exports startSandbox, with the interface of sandbox-node.mjs; loaded
// as the worker it runs the guest (sandbox-guest.mjs) once the page sends { type: "start", bytes, bindingUrl, grant }.
//
// The watchdog arms on "begin" and ends the worker when no "end" arrives within the call's budget: worker.terminate()
// interrupts a running wasm loop, and the page's own timers keep running meanwhile.
import { runGuest } from "./sandbox-guest.mjs";

const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const now = () => globalThis.performance.now();

/** Starts the worker for one extension. Resolves { ok, error, scope, sandbox }; see sandbox-node.mjs for `sandbox`. */
export function startSandbox({ bytes, bindingUrl, grant, onEvent = () => {}, startMs = 5000 }) {
  return new Promise((resolveStart) => {
    const worker = new Worker(new URL(import.meta.url), { type: "module" });
    let started = false;
    let ended = false;
    let pending = null;
    let nextId = 0;

    const kill = () => {
      ended = true;
      worker.terminate();
    };
    const settle = (result) => {
      const call = pending;
      if (!call) return;
      pending = null;
      clearTimeout(call.watchdog);
      call.resolve({ ok: false, error: null, budgetExceeded: false, callMs: null, memoryBytes: 0, ...result });
    };
    const startFailed = (error) => {
      if (started) return;
      started = true;
      clearTimeout(startGuard);
      kill();
      resolveStart({ ok: false, error });
    };
    const startGuard = setTimeout(() => startFailed(`the worker did not start within ${startMs} ms`), startMs);

    const sandbox = {
      get ended() { return ended; },
      call(op, args, budgetMs) {
        if (ended) return Promise.resolve({ ok: false, error: `${op}: the worker has ended`, budgetExceeded: false, memoryBytes: 0 });
        return new Promise((resolve) => {
          const id = ++nextId;
          pending = { id, op, resolve, budgetMs, began: 0, watchdog: null };
          worker.postMessage({ id, op, args });
        });
      },
      setGrant(index, tokens) {
        if (!ended) worker.postMessage({ type: "grant", index, grant: [...tokens] });
      },
      terminate() {
        if (!ended) kill();
        settle({ error: "the worker was ended" });
      },
    };

    // The watchdog: the containment of a call that never returns.
    const arm = (call) => {
      const budgetMs = call.budgetMs;
      call.began = now();
      const expire = () => {
        const callMs = Math.round(now() - call.began);
        kill();
        settle({ budgetExceeded: true, callMs, error: `${call.op} ran over its ${budgetMs} ms budget; the worker was ended after ${callMs} ms` });
      };
      const watchdog = setTimeout(() => expire(), budgetMs);
      call.watchdog = watchdog;
    };

    worker.addEventListener("message", ({ data: message }) => {
      if (ended) return;
      if (message.type === "event") onEvent(message.event);
      else if (message.type === "ready") {
        started = true;
        clearTimeout(startGuard);
        resolveStart({ ok: true, exports: message.exports, scope: message.scope, sandbox });
      } else if (message.type === "failed") startFailed(message.error);
      else if (message.type === "begin" && pending && pending.id === message.id) arm(pending);
      else if (message.type === "end" && pending && pending.id === message.id) {
        const callMs = Math.round(now() - pending.began);
        settle({ ok: message.ok, error: message.error || null, callMs, memoryBytes: message.memoryBytes });
      }
    });
    worker.addEventListener("error", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      const error = oneLine((event && event.message) || "the worker script failed");
      if (!started) return startFailed(error);
      kill();
      settle({ error: `the worker failed: ${error}` });
    });
    worker.postMessage({ type: "start", bytes, bindingUrl, grant: [...grant] });
  });
}

// ---- Loaded as the worker ----

const inWorker = typeof globalThis.DedicatedWorkerGlobalScope === "function" && globalThis instanceof globalThis.DedicatedWorkerGlobalScope;
if (inWorker) {
  globalThis.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type !== "start") return;
    runGuest({
      post: (message) => globalThis.postMessage(message),
      onMessage: (handler) => globalThis.addEventListener("message", (next) => { if (next.data && next.data.type !== "start") handler(next.data); }),
    }, data);
  }, { once: true });
}
