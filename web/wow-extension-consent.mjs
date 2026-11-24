// web/wow-extension-consent.mjs
//
// The user's consent for the tokens a world's extensions request: the Lab's own grant store, the consent dialog and
// the Extensions panel. The store and the dialog logic are kept apart from rendering; the two DOM builders at the end
// take an injected document and insert every piece of extension-supplied text (labels, file names, tokens, purposes)
// with textContent, never as markup.
//
// Grants are keyed by placement: the world file URL without query or fragment, the node id, module.integrity and
// attach (the same key the extension host gives the extension's storage, runtime/extension-host/capabilities.mjs
// placementKey). A new hash or a new attachment is a new placement, which asks again.
//
// A grant record is { placementKey, tokens, purposes, grantedAt, expiresAt, withdrawnAt }. With "Remember for this
// world" it is kept for 30 days in localStorage under GRANT_PREFIX + placementKey; otherwise it lives for this page
// session, in memory. ue.device.actuate.* is never remembered. A token is granted only when the placement key, the
// token and its purpose all match a record that is current (not expired, not withdrawn). Withdrawing writes
// withdrawnAt.

export const GRANT_PREFIX = "ue-grants:";
export const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
export const POINTER_TOKEN = "ue.input.pointer";

const PROMPTED = new Set(["ue.ui.panel", "ue.input.pointer", "ue.storage.local"]);
const PROMPTED_FAMILY = /^(?:ue\.network\.fetch:https?:\/\/[^/\s]+|ue\.device\.actuate\.[a-z0-9-]+(?:\.[a-z0-9-]+)*|sensor\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+)$/;
const NEVER_REMEMBERED = /^ue\.device\.actuate\./;

/** True for a token that needs the user's consent before any grant names it. */
export function isPromptedToken(token) {
  return typeof token === "string" && (PROMPTED.has(token) || PROMPTED_FAMILY.test(token));
}

/** The prompted tokens a declaration requests. */
export function promptedTokens(declaration) {
  const requests = declaration && Array.isArray(declaration.requests) ? declaration.requests : [];
  return requests.filter(isPromptedToken);
}

/** The purpose text a declaration gives for `token` ("" when it gives none). */
export function purposeOf(declaration, token) {
  const purposes = declaration && declaration.purposes && typeof declaration.purposes === "object" ? declaration.purposes : {};
  return typeof purposes[token] === "string" ? purposes[token] : "";
}

/** The placement key: the same form as placementKey in runtime/extension-host/capabilities.mjs. */
export function placementKeyOf({ world = "", node = "", integrity = "", attach = null } = {}) {
  return JSON.stringify([String(world).replace(/[?#].*$/s, ""), String(node), String(integrity), attach === undefined ? null : attach]);
}

const readJson = (storage, key) => {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
const writeJson = (storage, key, value) => {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

/**
 * createGrantStore({ storage, now }) -> the grant store of one page session. `storage` has the localStorage interface
 * (remembered grants; none kept when it is null); session grants are kept in this store's memory.
 */
export function createGrantStore({ storage = null, now = () => Date.now() } = {}) {
  const session = new Map();
  const current = (record, at) => !!record && record.placementKey !== undefined && !record.withdrawnAt && (record.expiresAt === null || record.expiresAt > at);
  const records = (key) => [session.get(key), readJson(storage, GRANT_PREFIX + key)].filter(Boolean);
  const merge = (record, key, tokens, purposes, at, expiresAt) => {
    const kept = record && current(record, at) ? record : { tokens: [], purposes: {} };
    return {
      placementKey: key,
      tokens: [...new Set([...kept.tokens, ...tokens])],
      purposes: { ...kept.purposes, ...purposes },
      grantedAt: at,
      expiresAt,
      withdrawnAt: null,
    };
  };
  return {
    /** The tokens of `declaration` that a current record grants at `key`, each with its purpose unchanged. */
    granted(key, declaration) {
      const at = now();
      const live = records(key).filter((record) => current(record, at));
      return promptedTokens(declaration).filter((token) => live.some((record) => Array.isArray(record.tokens) && record.tokens.includes(token)
        && record.purposes && record.purposes[token] === purposeOf(declaration, token)));
    },
    /** Records the user's Allow: `tokens` of `declaration` at `key`, remembered for 30 days when `remember`. */
    grant(key, declaration, tokens, { remember = false } = {}) {
      const at = now();
      const purposes = Object.fromEntries(tokens.map((token) => [token, purposeOf(declaration, token)]));
      const kept = remember ? tokens.filter((token) => !NEVER_REMEMBERED.test(token)) : [];
      const inSession = tokens.filter((token) => !kept.includes(token));
      if (kept.length) {
        const stored = readJson(storage, GRANT_PREFIX + key);
        const keptPurposes = Object.fromEntries(kept.map((token) => [token, purposes[token]]));
        if (!writeJson(storage, GRANT_PREFIX + key, merge(stored, key, kept, keptPurposes, at, at + REMEMBER_MS))) inSession.push(...kept);
      }
      if (inSession.length) {
        const sessionPurposes = Object.fromEntries(inSession.map((token) => [token, purposes[token]]));
        session.set(key, merge(session.get(key), key, inSession, sessionPurposes, at, null));
      }
      return this.granted(key, declaration);
    },
    /** Withdraws every grant at `key` at once: each record gets withdrawnAt, and the stored one is written back. */
    withdraw(key) {
      const at = now();
      const held = session.get(key);
      if (held && !held.withdrawnAt) session.set(key, { ...held, withdrawnAt: at });
      const stored = readJson(storage, GRANT_PREFIX + key);
      if (stored && !stored.withdrawnAt) writeJson(storage, GRANT_PREFIX + key, { ...stored, withdrawnAt: at });
      else if (!stored && held) writeJson(storage, GRANT_PREFIX + key, { ...held, withdrawnAt: at });
      return at;
    },
    /** The records at `key`: { session, stored }. */
    records: (key) => ({ session: session.get(key) || null, stored: readJson(storage, GRANT_PREFIX + key) }),
  };
}

// ---- Rendering (DOM, injected document; text only through textContent) ----

const STYLE = {
  surface: "background:var(--osl-glass-bg, rgba(14,18,28,0.96));color:var(--ink, #f4f6fb);border:1px solid var(--line, rgba(255,255,255,0.18));"
    + "border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,0.45);font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;",
  dim: "color:var(--ink-dim, #aab3c5);",
  mono: "font:12px/1.4 ui-monospace,Menlo,monospace;overflow-wrap:anywhere;",
  button: "border:1px solid var(--line, rgba(255,255,255,0.25));border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer;"
    + "background:rgba(255,255,255,0.06);color:inherit;",
  primary: "border:1px solid #7ee0a8;border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer;background:#1f5c3d;color:#ffffff;",
};

function el(doc, tag, { style = "", text = null, attrs = {} } = {}, children = []) {
  const node = doc.createElement(tag);
  if (style) node.setAttribute("style", style);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== null) node.textContent = String(text);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** The module's file name from its URL (a data: URL shows as "inline module"). */
export function moduleFileName(url) {
  const text = String(url || "");
  if (/^data:/i.test(text)) return "inline module";
  try {
    const path = new URL(text, "http://local.invalid/").pathname;
    return decodeURIComponent(path.split("/").pop() || text);
  } catch {
    return text.split(/[/?#]/).filter(Boolean).pop() || text;
  }
}
const hashPrefix = (integrity) => `${String(integrity || "").slice(0, 19)}…`;
// The glance list (web/wow-extension-glance.mjs) is drawn with the same look and the same text-only element builder.
export { STYLE as PANEL_STYLE, el as panelElement };

/**
 * buildConsentDialog(doc, request) -> { element, result } where request is { extension (label#index), label,
 * moduleUrl, integrity, tokens, purposes, carrier? } (carrier { subject, fingerprint } for an extension from a signed
 * carrier manifest; the fingerprint is the adapter's keyFingerprint of the signer's key, the first 16 hexadecimal
 * characters of the SHA-256 of its SPKI DER bytes in groups of four) and result resolves { allowed: [...tokens], remember } when the user
 * answers. Deny, the close button and Escape all answer with nothing allowed.
 */
export function buildConsentDialog(doc, { extension, label, moduleUrl, integrity, tokens, purposes = {}, carrier = null }) {
  let answer;
  const result = new Promise((resolve) => { answer = resolve; });
  const element = el(doc, "section", {
    style: `position:fixed;z-index:60;top:72px;left:50%;transform:translateX(-50%);width:min(520px,calc(100vw - 32px));padding:16px 18px;${STYLE.surface}`,
    attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Extension permission", "data-testid": "ue-consent-dialog", "data-ue-extension": extension },
  });
  const close = el(doc, "button", { style: `position:absolute;top:8px;right:8px;${STYLE.button}padding:2px 8px;`, text: "×", attrs: { type: "button", "aria-label": "Close (deny)", "data-ue-action": "close" } });
  const heading = el(doc, "h2", { style: "margin:0 0 6px;font-size:15px;", text: "An extension in this world asks for permission" });
  const where = el(doc, "div", { style: STYLE.dim }, [
    el(doc, "div", {}, [doc.createTextNode("World node: "), el(doc, "strong", { text: label, attrs: { "data-ue-field": "label" } })]),
    el(doc, "div", {}, [doc.createTextNode("Module: "), el(doc, "span", { style: STYLE.mono, text: moduleFileName(moduleUrl), attrs: { "data-ue-field": "module" } }),
      doc.createTextNode(" "), el(doc, "span", { style: STYLE.mono, text: hashPrefix(integrity), attrs: { "data-ue-field": "hash" } })]),
    carrier ? el(doc, "div", {}, [doc.createTextNode("Signed by: "), el(doc, "span", { style: STYLE.mono, text: carrier.subject, attrs: { "data-ue-field": "carrier-subject" } }),
      doc.createTextNode(" key "), el(doc, "span", { style: STYLE.mono, text: carrier.fingerprint, attrs: { "data-ue-field": "carrier-key" } })]) : null,
  ]);
  const list = el(doc, "ul", { style: "list-style:none;margin:12px 0;padding:0;display:grid;gap:8px;" });
  for (const token of tokens) {
    const choice = el(doc, "input", { attrs: { type: "checkbox", "data-ue-token-choice": token } });
    choice.checked = true;
    const purpose = typeof purposes[token] === "string" && purposes[token] ? purposes[token] : "";
    const row = el(doc, "li", { attrs: { "data-ue-token": token } }, [
      el(doc, "label", { style: "display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:start;cursor:pointer;" }, [
        choice,
        el(doc, "span", { style: STYLE.mono, text: token, attrs: { class: "ue-consent-token" } }),
        el(doc, "span", {}),
        el(doc, "span", { style: purpose ? "" : STYLE.dim, text: purpose || "No purpose given.", attrs: { class: "ue-consent-purpose" } }),
      ]),
    ]);
    list.append(row);
  }
  const remember = el(doc, "input", { attrs: { type: "checkbox", "data-ue-remember": "" } });
  const actuate = tokens.some((token) => NEVER_REMEMBERED.test(token));
  const rememberRow = el(doc, "label", { style: `display:flex;gap:8px;align-items:center;${STYLE.dim}` }, [
    remember, doc.createTextNode(actuate ? "Remember for this world (30 days; device actions are never remembered)" : "Remember for this world (30 days)"),
  ]);
  const deny = el(doc, "button", { style: STYLE.button, text: "Deny", attrs: { type: "button", "data-ue-action": "deny" } });
  const allow = el(doc, "button", { style: STYLE.primary, text: "Allow selected", attrs: { type: "button", "data-ue-action": "allow" } });
  const actions = el(doc, "div", { style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;" }, [deny, allow]);
  element.append(close, heading, where, list, rememberRow, actions);

  const finish = (allowed) => {
    if (!answer) return;
    const done = answer;
    answer = null;
    element.removeEventListener("keydown", onKey);
    element.remove();
    done({ allowed, remember: allowed.length ? remember.checked : false });
  };
  const onKey = (event) => { if (event.key === "Escape") finish([]); };
  element.addEventListener("keydown", onKey);
  close.addEventListener("click", () => finish([]));
  deny.addEventListener("click", () => finish([]));
  allow.addEventListener("click", () => finish([...list.querySelectorAll("input[data-ue-token-choice]")].filter((box) => box.checked).map((box) => box.getAttribute("data-ue-token-choice"))));
  return { element, result, dismiss: () => finish([]) };
}

/**
 * createConsentQueue(doc) -> { ask(request) -> Promise<{ allowed, remember }>, clear() }. Shows one dialog at a time,
 * in the order asked. clear() removes the open dialog and the waiting ones, each answered with nothing allowed.
 */
export function createConsentQueue(doc) {
  const waiting = [];
  let open = null;
  const next = () => {
    if (open || !waiting.length) return;
    const item = waiting.shift();
    const dialog = buildConsentDialog(doc, item.request);
    open = dialog;
    (doc.body || doc.documentElement).append(dialog.element);
    const focus = dialog.element.querySelector('[data-ue-action="allow"]');
    if (focus && typeof focus.focus === "function") focus.focus();
    dialog.result.then((answer) => {
      open = null;
      item.resolve(answer);
      next();
    });
  };
  return {
    ask(request) {
      return new Promise((resolve) => {
        waiting.push({ request, resolve });
        next();
      });
    },
    clear() {
      for (const item of waiting.splice(0)) item.resolve({ allowed: [], remember: false, cleared: true });
      if (open) open.dismiss();
    },
  };
}

/**
 * renderExtensionsPanel({ document, mounted, onClose }) -> { element, refresh(), close() }: the Extensions panel of one
 * mount pass. Each extension is listed with its state (not started, starting, running, refused, failed, ended), its
 * granted tokens, where its code came from once it is started ("code from this place" or "code from its maker"), a
 * "slow" line with the count of its calls over the event budget (when it has any) and a Withdraw button, which calls
 * mounted.withdraw(record) and takes effect at once.
 */
export function renderExtensionsPanel({ document: doc, mounted, onClose = null }) {
  const element = el(doc, "section", {
    style: `position:fixed;z-index:59;top:72px;right:16px;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 96px);overflow:auto;padding:14px 16px;${STYLE.surface}`,
    attrs: { role: "dialog", "aria-modal": "false", "aria-label": "Extensions", "data-testid": "ue-extensions-panel" },
  });
  const closeButton = el(doc, "button", { style: `position:absolute;top:8px;right:8px;${STYLE.button}padding:2px 8px;`, text: "×", attrs: { type: "button", "aria-label": "Close the Extensions panel" } });
  const heading = el(doc, "h2", { style: "margin:0 0 10px;font-size:15px;", text: "Extensions" });
  const list = el(doc, "ul", { style: "list-style:none;margin:0;padding:0;display:grid;gap:10px;" });
  element.append(closeButton, heading, list);
  let unsubscribe = null;

  function refresh() {
    list.replaceChildren();
    const records = mounted && Array.isArray(mounted.records) ? mounted.records : [];
    if (!records.length) list.append(el(doc, "li", { style: STYLE.dim, text: "This world carries no extensions." }));
    for (const record of records) {
      const state = mounted.stateOf(record);
      const prompted = mounted.promptedGrant(record);
      const tokens = record.grant || [];
      const row = el(doc, "li", { style: "border-top:1px solid var(--line, rgba(255,255,255,0.12));padding-top:8px;", attrs: { "data-ue-extension": `${record.label}#${record.index}` } }, [
        el(doc, "div", { style: "display:flex;gap:8px;align-items:baseline;justify-content:space-between;" }, [
          el(doc, "strong", { text: record.label }),
          el(doc, "span", { style: `${STYLE.mono}${state === "running" ? "color:#7ee0a8;" : "color:#ffb48a;"}`, text: state, attrs: { "data-ue-state": "" } }),
        ]),
        el(doc, "div", { style: `${STYLE.mono}${STYLE.dim}`, text: moduleFileName(record.module_url || (record.declaration && record.declaration.module && record.declaration.module.url)) }),
        el(doc, "div", { style: STYLE.mono, text: tokens.length ? tokens.join(", ") : "no tokens granted", attrs: { class: "ue-extension-tokens" } }),
      ]);
      // Where a started extension's code came from: the place's store, or its maker's address. Plain text, no address.
      if (record.codeSource === "place" || record.codeSource === "maker") {
        row.append(el(doc, "div", { style: `${STYLE.mono}${STYLE.dim}`, text: record.codeSource === "place" ? "code from this place" : "code from its maker", attrs: { "data-ue-code-source": record.codeSource } }));
      }
      // A carrier the place's withdrawn list does not name (or a world with no list) runs; the user is told, as plain text.
      if (record.carrier && record.carrier.revocationStatus === "unchecked") {
        row.append(el(doc, "div", { style: `${STYLE.mono}${STYLE.dim}`, text: "status not checked", attrs: { "data-ue-revocation": "unchecked" } }));
      }
      // An extension with calls over its event budget runs on; the user is told how many, as plain text.
      if (record.extension && record.extension.overruns > 0) {
        const overruns = record.extension.overruns;
        row.append(el(doc, "div", { style: `${STYLE.mono}color:#ffb48a;`, text: `slow: ${overruns} ${overruns === 1 ? "call" : "calls"} over the time budget`, attrs: { "data-ue-slow": String(overruns) } }));
      }
      const withdraw = el(doc, "button", { style: `${STYLE.button}margin-top:6px;`, text: "Withdraw", attrs: { type: "button", "data-ue-withdraw": `${record.label}#${record.index}` } });
      if (!prompted.length) {
        withdraw.disabled = true;
        withdraw.setAttribute("style", `${STYLE.button}margin-top:6px;opacity:0.45;cursor:default;`);
        withdraw.title = "No permission the user gave to withdraw";
      }
      withdraw.addEventListener("click", () => {
        mounted.withdraw(record);
        refresh();
      });
      row.append(withdraw);
      list.append(row);
    }
  }
  function close() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    element.remove();
    if (typeof onClose === "function") onClose();
  }
  closeButton.addEventListener("click", close);
  if (mounted && typeof mounted.subscribe === "function") unsubscribe = mounted.subscribe(refresh);
  refresh();
  return { element, refresh, close };
}

export default { GRANT_PREFIX, REMEMBER_MS, createGrantStore, createConsentQueue, buildConsentDialog, renderExtensionsPanel, placementKeyOf, isPromptedToken };
