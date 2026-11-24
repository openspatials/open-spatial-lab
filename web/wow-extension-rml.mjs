// web/wow-extension-rml.mjs
//
// RP1 panel markup (RML with RCSS, as RP1's creator panels write it) to a panel document. The `rml` root becomes the
// document's root; everything else passes on unchanged to the same filter as any panel document
// (web/wow-extension-panel-filter.mjs), which accepts or refuses it whole. RP1 panels are display only: they have no
// input, and nothing here adds any.
//
// Three RCSS habits are written the way a browser reads them, in the style text only:
//   - rgba() alpha from 0 to 255 (RCSS) becomes 0 to 1;
//   - a rule with border-width and no border-style gets border-style: solid (RCSS draws a border without one);
//   - an image whose source is camera://<n> shows CAMERA_PLACEHOLDER, a host image. No camera is opened.
// PURE: string in, string out.

/** The host's placeholder for a camera picture: a 160 x 90 PNG, drawn by the host. */
export const CAMERA_PLACEHOLDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAABVElEQVR42u3XOXICMRBAUc5imx2zeMMnJSD0SZ1RToxNoRm1Wq/qh1Krql8wMHmYbZW4iRUAFmABVh3gx/lOiQMMWIAFWIAFWIAFuCvgp8VeiQMMWIAFWIAFWIAFuCvg6fKgxAEGLMACLMACLMBqGfh0/opQS8Cz1UtDBQFuaGOAAYcE7vB1wIC7B657HfBQKy71NQUcEbjgLybA4YCvny87DfDYwP85XHxgOOD5+rWhLisOfjJOyYFvGgsYMOAYwLdKDDQWMGDAgAH7BgMG7H9wVuDF5q2hLisudbj4wGhlBv7zfNlpgCsA/7zyW4O+Dnhw4OvGI7wOeLwV170OOPqKAQMGXGjFdQMMOAzw8vm9oYIAN7SxxoAFWIABC7AAC7AA6z7g1fZDiQMMWIAFWIAFWIAFuCvg9e6oxAEGLMACLMACLMAC3BXwZv+pxAEGLMAK2zd6G9tOqrI/YwAAAABJRU5ErkJggg==";

const RML_ROOT = /^\s*<rml(\s[^>]*)?>([\s\S]*)<\/rml>\s*$/i;

/** True when `text` is RML: its root element is `rml`. */
export function isRml(text) {
  return typeof text === "string" && RML_ROOT.test(text);
}

/** One style block's RCSS, written the way a browser reads it. */
function rcssToCss(css) {
  const alpha = css.replace(/rgba\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*([\d.]+)\s*\)/gi, (whole, r, g, b, a) => {
    const value = Number(a);
    return value > 1 ? `rgba(${r.trim()}, ${g.trim()}, ${b.trim()}, ${Math.round((value / 255) * 1000) / 1000})` : whole;
  });
  return alpha.replace(/\{([^{}]*)\}/g, (whole, body) => (/border-width\s*:/i.test(body) && !/border-style\s*:/i.test(body) ? `{${body.replace(/;?\s*$/, ";")} border-style: solid; }` : whole));
}

/**
 * rmlToPanelDocument(text) -> the panel document of an RML document: the `rml` root becomes `html`, each style block's
 * RCSS is written as CSS and each camera:// image source becomes CAMERA_PLACEHOLDER. Text that is not RML comes back
 * unchanged.
 */
export function rmlToPanelDocument(text) {
  const match = typeof text === "string" ? RML_ROOT.exec(text) : null;
  if (!match) return text;
  const inner = match[2]
    .replace(/(<style(?:\s[^>]*)?>)([\s\S]*?)(<\/style>)/gi, (whole, open, css, close) => `${open}${rcssToCss(css)}${close}`)
    .replace(/(\ssrc\s*=\s*)(["'])camera:\/\/[^"']*\2/gi, (whole, lead, quote) => `${lead}${quote}${CAMERA_PLACEHOLDER}${quote}`);
  return `<html>${inner}</html>`;
}

export default { isRml, rmlToPanelDocument, CAMERA_PLACEHOLDER };
