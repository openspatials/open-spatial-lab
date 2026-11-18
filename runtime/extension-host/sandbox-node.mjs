// The Node adapter of the sandbox: one worker_threads worker per extension, and the main-thread watchdog that ends it
// when a call runs over budget. Imported on the main thread it exports startSandbox; loaded as the worker it runs the
// guest (sandbox-guest.mjs). The browser adapter is sandbox-web.mjs, with the same interface.
//
// The watchdog arms on "begin" and ends the worker when no "end" arrives within the call's budget, so a module that
// never returns cannot hold the main thread or the host: worker.terminate() interrupts a running wasm loop.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { runGuest } from "./sandbox-guest.mjs";

const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();

/**
 * Starts the worker for one extension. Resolves { ok, error, scope, sandbox } once the module is compiled and
 * instantiated inside it. `sandbox.call(op, args, budgetMs)` runs one lifecycle call ("init", "open", "close",
 * "shutdown", or "notify" for a binding with its own lifecycle) and resolves { ok, error, budgetExceeded, callMs,
 * memoryBytes }; it never rejects. Calls must not overlap: the caller awaits one before it starts the next.
 * `sandbox.setGrant(index, tokens)` replaces one attachment's grant in the worker; the worker applies it before the
 * next call.
 */
export function startSandbox({ bytes, bindingUrl, grant, onEvent = () => {}, startMs = 5000 }) {
  return new Promise((resolveStart) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { extensionSandbox: true, bytes, bindingUrl, grant: [...grant] },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let started = false;
    let ended = false;
    let pending = null;
    let nextId = 0;

    const kill = () => {
      ended = true;
      worker.terminate().catch(() => {});
    };
    const settle = (result) => {
      const call = pending;
      if (!call) return;
      pending = null;
      clearTimeout(call.watchdog);
      worker.unref();
      call.resolve({ ok: false, error: null, budgetExceeded: false, callMs: null, memoryBytes: 0, ...result });
    };
    const startGuard = setTimeout(() => {
      if (started) return;
      kill();
      resolveStart({ ok: false, error: `the worker did not start within ${startMs} ms` });
    }, startMs);

    const sandbox = {
      get ended() { return ended; },
      call(op, args, budgetMs) {
        if (ended) return Promise.resolve({ ok: false, error: `${op}: the worker has ended`, budgetExceeded: false, memoryBytes: 0 });
        return new Promise((resolve) => {
          const id = ++nextId;
          pending = { id, op, resolve, budgetMs, began: 0, watchdog: null };
          worker.ref();
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
      call.began = performance.now();
      const expire = () => {
        const callMs = Math.round(performance.now() - call.began);
        kill();
        settle({ budgetExceeded: true, callMs, error: `${call.op} ran over its ${budgetMs} ms budget; the worker was ended after ${callMs} ms` });
      };
      const watchdog = setTimeout(() => expire(), budgetMs);
      call.watchdog = watchdog;
    };

    worker.on("message", (message) => {
      if (message.type === "event") onEvent(message.event);
      else if (message.type === "ready") {
        started = true;
        clearTimeout(startGuard);
        worker.unref();
        resolveStart({ ok: true, exports: message.exports, scope: message.scope, sandbox });
      } else if (message.type === "failed") {
        started = true;
        clearTimeout(startGuard);
        kill();
        resolveStart({ ok: false, error: message.error });
      } else if (message.type === "begin" && pending && pending.id === message.id) arm(pending);
      else if (message.type === "end" && pending && pending.id === message.id) {
        const callMs = Math.round(performance.now() - pending.began);
        settle({ ok: message.ok, error: message.error || null, callMs, memoryBytes: message.memoryBytes });
      }
    });
    worker.on("error", (error) => {
      ended = true;
      if (!started) {
        started = true;
        clearTimeout(startGuard);
        resolveStart({ ok: false, error: oneLine(error) });
      }
      settle({ error: `the worker failed: ${oneLine(error)}` });
    });
    worker.on("exit", () => {
      ended = true;
      if (!started) {
        started = true;
        clearTimeout(startGuard);
        resolveStart({ ok: false, error: "the worker exited before it started" });
      }
      settle({ error: "the worker exited" });
    });
  });
}

if (!isMainThread && workerData && workerData.extensionSandbox) {
  runGuest({ post: (message) => parentPort.postMessage(message), onMessage: (handler) => parentPort.on("message", handler) }, workerData);
}
