export function fixed3(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(3) : "—";
}
export function vec3Label(value) {
  return Array.isArray(value) ? value.slice(0, 3).map(fixed3).join(", ") : "—";
}
export function yawQuaternion(yaw) {
  const half = (Number(yaw) || 0) / 2;
  return [0, Number(Math.sin(half).toFixed(6)), 0, Number(Math.cos(half).toFixed(6))];
}
export function roundedVec3(value) {
  return Array.isArray(value) ? value.slice(0, 3).map((entry) => Number((Number(entry) || 0).toFixed(3))) : [0, 0, 0];
}
export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}
