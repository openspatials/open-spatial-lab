export function createDebugWriter(lookup, body) {
  return {
    element: lookup,
    attribute: (name, value) => body.setAttribute(name, value),
    text(id, value) { const element = lookup(id); if (element) element.textContent = value; },
    bool(id, value) {
      const element = lookup(id); if (!element) return;
      if (typeof value !== "boolean") { element.textContent = "—"; element.classList.remove("debug-true", "debug-false"); return; }
      element.textContent = String(value);
      element.classList.toggle("debug-true", value === true);
      element.classList.toggle("debug-false", value === false);
    },
  };
}
