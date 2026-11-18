// Which files of runtime/extension-host/ a site package carries, for a page to load from /vendor/extension-host/
// (as src/serve.js serves the folder). Every file but the Node-only ones: sandbox-node.mjs (the worker_threads adapter)
// and this list itself. Read by the site package builder; no page imports it.

/** Paths under runtime/extension-host/, with "/" separators, that stay out of a site package. */
export const NODE_ONLY_FILES = Object.freeze(["sandbox-node.mjs", "site-files.mjs"]);

/** Does a site package carry `path` (relative to runtime/extension-host/)? */
export function isSiteFile(path) {
  return !NODE_ONLY_FILES.includes(path);
}
