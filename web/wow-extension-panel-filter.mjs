// web/wow-extension-panel-filter.mjs
//
// The panel filter: reads an extension's panel document and gives back a description of a new tree built from the
// allowed parts only (web/wow-extension-panel-profile.mjs), or refuses the whole document with a reason that names the
// refused part. It never edits the input and never shows a reduced form of it.
//
// The document is parsed by the browser's own HTML parser into an inert document (DOMParser: nothing in it loads or
// runs), and its style block by the browser's own style parser (a constructed style sheet), so the filter reads what a
// browser would read. Each element, attribute, style rule, selector, property and value is then checked against the
// profile's lists. The result is plain data: text stays text, and each style is a list of [property, value, priority]
// that the panel sets one by one through the style object (web/wow-extension-panel.mjs), never as style text.
//
// The filter needs a window (for DOMParser and CSSStyleSheet) and makes no request: an image address is read as text and
// checked, and no element is ever made in a live document.
import {
  PANEL_ATTRIBUTES, PANEL_BUTTON_TYPES, PANEL_DOCUMENT_BYTES, PANEL_ELEMENTS, PANEL_HOST_FONTS, PANEL_IMAGE_BYTES,
  PANEL_IMAGE_TYPES, PANEL_INPUT_TYPES, PANEL_LENGTH_UNITS, PANEL_MAX_DEPTH, PANEL_MAX_ELEMENTS, PANEL_PROPERTY_LONGHANDS,
  PANEL_PSEUDO_CLASSES, PANEL_STYLE_PROPERTIES, PANEL_TEXT_FIELDS, PANEL_VALUE_FUNCTIONS, PANEL_WIDE_KEYWORDS, PANEL_WRAPPERS,
} from "./wow-extension-panel-profile.mjs";

const XHTML = "http://www.w3.org/1999/xhtml";
const WRAPPER_ATTRIBUTES = ["lang", "dir"];
const SELECTOR_ELEMENTS = [...PANEL_ELEMENTS.filter((tag) => tag !== "style"), "html", "body"];
const COMPOUND = /^(\*|[a-z][a-z0-9]*)?((?:[#.][A-Za-z_-][\w-]*|:[a-z-]+)*)$/i;
const DATA_IMAGE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9=._+-]+)*);base64,([A-Za-z0-9+/=\s]*)$/i;
const encoder = new TextEncoder();

class Refused extends Error {}
const refuse = (reason) => { throw new Refused(reason); };
// A name or value from the document, as a reason shows it: plain words only, so no reason names an address or a site.
const named = (value) => (/^[A-Za-z0-9 _:#,%+-]{1,40}$/.test(String(value)) ? String(value) : "(a name not shown)");
// A selector, as a reason shows it: shown unless it is long or has a dot between two words (as a site name would).
const namedSelector = (value) => (/^[A-Za-z0-9 _.#:>,*-]{1,40}$/.test(String(value)) && !/[A-Za-z0-9-]\.[A-Za-z]/.test(String(value)) ? String(value) : "(a selector not shown)");

/** The profile property a parsed property name belongs to (itself, or the shorthand it is a longhand of), or null. */
function ownerOf(name) {
  if (Object.hasOwn(PANEL_STYLE_PROPERTIES, name)) return name;
  for (const [shorthand, longhands] of Object.entries(PANEL_PROPERTY_LONGHANDS)) if (longhands.includes(name)) return shorthand;
  return null;
}

/** Refuses style text that has an at-rule or calls a function the profile does not list. */
function checkStyleText(text, where) {
  if (text.includes("@")) refuse(`${where} has an at-rule (@); none is allowed`);
  for (const match of text.matchAll(/([A-Za-z_\\-][\w\\-]*)\(/g)) {
    const name = match[1].toLowerCase();
    if (!PANEL_VALUE_FUNCTIONS.includes(name)) refuse(`${where} calls ${named(name)}(), which is not allowed`);
  }
}

function checkValue(owner, name, value, where) {
  const lower = value.toLowerCase();
  if (PANEL_WIDE_KEYWORDS.includes(lower)) return;
  const keywords = PANEL_STYLE_PROPERTIES[owner];
  if (keywords) {
    if (!keywords.includes(lower)) refuse(`${where}: ${name}: ${named(value)} is not allowed`);
    return;
  }
  if (owner === "font-family") {
    for (const family of value.split(",").map((item) => item.trim().replace(/^["']|["']$/g, ""))) {
      if (!PANEL_HOST_FONTS.some((font) => font.toLowerCase() === family.toLowerCase())) refuse(`${where}: font ${named(family)} is not a host font`);
    }
    return;
  }
  for (const match of lower.matchAll(/([a-z-]+)\(/g)) if (!PANEL_VALUE_FUNCTIONS.includes(match[1])) refuse(`${where}: ${name} calls ${named(match[1])}(), which is not allowed`);
  for (const match of lower.replace(/#[0-9a-f]+/g, "").matchAll(/(?:^|[^a-z0-9.-])-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?([a-z%]+)/g)) {
    if (!PANEL_LENGTH_UNITS.includes(match[1])) refuse(`${where}: ${name}: the unit ${named(match[1])} is not allowed`);
  }
}

/** The declarations of a parsed style object as [[property, value, priority]], each checked. */
function readDeclarations(style, where) {
  const out = [];
  for (let at = 0; at < style.length; at += 1) {
    const name = style.item(at).toLowerCase();
    const owner = ownerOf(name);
    if (!owner) refuse(`${where}: property ${named(name)} is not allowed`);
    const value = style.getPropertyValue(name).trim();
    if (!value) continue;
    checkValue(owner, name, value, where);
    out.push([name, value, style.getPropertyPriority(name)]);
  }
  return out;
}

function checkSelector(text) {
  for (const part of text.split(",")) {
    const compounds = part.trim().split(/\s*>\s*|\s+/);
    for (const compound of compounds) {
      const match = COMPOUND.exec(compound);
      if (!compound || !match) refuse(`selector ${namedSelector(part.trim())} is not allowed`);
      if (match[1] && match[1] !== "*" && !SELECTOR_ELEMENTS.includes(match[1].toLowerCase())) refuse(`selector ${namedSelector(part.trim())} names the element ${named(match[1])}, which is not allowed`);
      for (const pseudo of match[2].matchAll(/:([a-z-]+)/gi)) {
        if (!PANEL_PSEUDO_CLASSES.includes(pseudo[1].toLowerCase())) refuse(`selector ${namedSelector(part.trim())} uses :${named(pseudo[1])}, which is not allowed`);
      }
    }
  }
}

/** The rules of the style block: [{ selector, declarations }], parsed by a constructed style sheet. */
function readStyleBlock(win, text) {
  checkStyleText(text, "the style block");
  if (typeof win.CSSStyleSheet !== "function") refuse("this browser has no style parser for the style block");
  const sheet = new win.CSSStyleSheet();
  sheet.replaceSync(text);
  const rules = [];
  for (const rule of sheet.cssRules) {
    if (rule.type !== 1 || typeof rule.selectorText !== "string") refuse(`a ${rule.constructor && rule.constructor.name ? named(rule.constructor.name) : "non-style"} rule is not allowed`);
    if (rule.cssRules && rule.cssRules.length) refuse(`rule ${namedSelector(rule.selectorText)} holds nested rules, which are not allowed`);
    checkSelector(rule.selectorText);
    rules.push({ selector: rule.selectorText, declarations: readDeclarations(rule.style, `rule ${namedSelector(rule.selectorText)}`) });
  }
  return rules;
}

function checkImage(src) {
  const text = String(src).trim();
  if (!/^data:/i.test(text)) refuse("img src is not a data: URL; only data: images are allowed");
  const match = DATA_IMAGE.exec(text);
  if (!match) refuse("img src is not a base64 data: URL");
  const type = match[1].toLowerCase();
  if (!PANEL_IMAGE_TYPES.includes(type)) refuse(`image type ${/^[a-z]+\/[a-z0-9+-]{1,30}$/.test(type) ? type : "(a type not shown)"} is not allowed`);
  const data = match[3].replace(/\s+/g, "");
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > PANEL_IMAGE_BYTES) refuse(`an image is ${bytes} bytes, over the ${PANEL_IMAGE_BYTES} byte limit`);
}

/**
 * filterPanelDocument(text, win) -> { ok: true, parts: { tree, rules, elements } } | { ok: false, reason }
 * `win` is the page's window (DOMParser, CSSStyleSheet). `tree` is a list of nodes: { text } or { tag, attrs: [[name,
 * value]], style: [[property, value, priority]], children }; `rules` is the style block as [{ selector, declarations }].
 */
export function filterPanelDocument(text, win) {
  try {
    if (typeof text !== "string") refuse("the document is not text");
    const bytes = encoder.encode(text).length;
    if (bytes > PANEL_DOCUMENT_BYTES) refuse(`the document is ${bytes} bytes, over the ${PANEL_DOCUMENT_BYTES} byte limit`);
    if (!win || typeof win.DOMParser !== "function") refuse("this host has no HTML parser for panels");
    const parsed = new win.DOMParser().parseFromString(text, "text/html");
    const state = { elements: 0, textFields: 0, rules: null };

    const readAttributes = (source, tag) => {
      const attrs = [];
      let style = [];
      for (const attr of [...source.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        if (!Object.hasOwn(PANEL_ATTRIBUTES, name)) refuse(`attribute ${named(name)} is not allowed`);
        const on = PANEL_ATTRIBUTES[name];
        if (on && !on.includes(tag)) refuse(`attribute ${name} is not allowed on ${tag}`);
        if (name === "style") {
          checkStyleText(value, `the style of a ${tag}`);
          style = readDeclarations(source.style, `the style of a ${tag}`);
          continue;
        }
        if (name === "src") checkImage(value);
        if (name === "type") {
          const allowed = tag === "input" ? PANEL_INPUT_TYPES : PANEL_BUTTON_TYPES;
          if (!allowed.includes(value.toLowerCase())) refuse(`${tag} type ${named(value)} is not allowed`);
        }
        attrs.push([name, value]);
      }
      if (tag === "input" && (source.getAttribute("type") || "text").toLowerCase() === "text") {
        state.textFields += 1;
        if (state.textFields > PANEL_TEXT_FIELDS) refuse(`more than ${PANEL_TEXT_FIELDS} text field`);
      }
      return { attrs, style };
    };

    const walk = (node, depth, out) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          out.push({ text: child.data });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.localName;
        if (child.namespaceURI !== XHTML) refuse(`element ${named(tag)} is not allowed`);
        if (PANEL_WRAPPERS.includes(tag)) {
          for (const attr of child.attributes) if (!WRAPPER_ATTRIBUTES.includes(attr.name.toLowerCase())) refuse(`attribute ${named(attr.name)} is not allowed on ${tag}`);
          walk(child, depth, out);
          continue;
        }
        if (!PANEL_ELEMENTS.includes(tag)) refuse(`element ${named(tag)} is not allowed`);
        if (tag === "style") {
          if (state.rules) refuse("more than one style block");
          if (child.attributes.length) refuse(`attribute ${named(child.attributes[0].name)} is not allowed on style`);
          state.rules = readStyleBlock(win, child.textContent);
          continue;
        }
        state.elements += 1;
        if (state.elements > PANEL_MAX_ELEMENTS) refuse(`the document has more than ${PANEL_MAX_ELEMENTS} elements`);
        if (depth + 1 > PANEL_MAX_DEPTH) refuse(`the document is more than ${PANEL_MAX_DEPTH} elements deep`);
        const { attrs, style } = readAttributes(child, tag);
        const item = { tag, attrs, style, children: [] };
        walk(child, depth + 1, item.children);
        out.push(item);
      }
    };
    const tree = [];
    walk(parsed, 0, tree);
    return { ok: true, parts: { tree, rules: state.rules || [], elements: state.elements } };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.message };
    return { ok: false, reason: `the document could not be read: ${String((error && error.message) || error).replace(/\s+/g, " ").trim()}` };
  }
}

export default { filterPanelDocument };
