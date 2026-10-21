/*
 * Canonical JSON transport and API activity bus for LiveAdapter.
 *
 * This module owns request sequencing, WoW validation-header accounting, and
 * transport telemetry. Route selection and every application-state decision
 * remain in LiveAdapter.
 */

export const API_EVENTS = new EventTarget();

export function displayPath(url) {
  const value = String(url || "");
  const match = value.match(/^https?:\/\/[^/]+(\/.*)$/);
  return match ? match[1] : value;
}

export function schemaLabelForUrl(url, method) {
  const value = String(url || "");
  if (/\/wow\/world(\?|$)/.test(value)) return "World";
  if (/\/wow\/user\//.test(value)) return "User";
  if (/\/wow\/view\//.test(value)) return "View";
  if (/\/wow\/portal\//.test(value)) return "Portal";
  if (/\/fabric\.json(\?|$)/.test(value)) return "fabric manifest";
  if (/\/portal\/exit-intent|\/wow\/portal\/exit/.test(value)) return "exit-intent (extension)";
  if (/\/portal\/arrival|\/wow\/portal\/arrival/.test(value)) return "arrival (extension)";
  if (/\/movement(\?|$)/.test(value)) return "movement (non-spec)";
  if (/\/debug\/state(\?|$)/.test(value)) return "debug/state (non-spec)";
  if (/\/reset(\?|$)/.test(value)) return "reset (non-spec)";
  return String(method || "GET") === "POST" ? "POST" : "resource";
}

function defaultFetch(...args) {
  return globalThis.fetch(...args);
}

function defaultCustomEvent(type, init) {
  return new CustomEvent(type, init);
}

function defaultNowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function defaultNowIso() {
  return new Date().toISOString();
}

export function createLiveAdapterTransport({
  fetchImpl = defaultFetch,
  apiEvents = API_EVENTS,
  createCustomEvent = defaultCustomEvent,
  nowMs = defaultNowMs,
  nowIso = defaultNowIso,
} = {}) {
  let requestSequence = 0;
  const contractValidation = {
    observed: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    schemas: new Set(),
    last: null,
  };

  function recordWowContractValidation(url, headerValue) {
    if (!/\/wow\//.test(String(url || ""))) return null;
    const raw = headerValue ? String(headerValue) : null;
    const match = raw && raw.match(/^(pass|fail):(.+)$/);
    const status = match ? match[1] : raw === "error" ? "error" : "unavailable";
    const schema = match ? match[2] : null;
    const record = {
      source: "X-OSL-WoW-Validation",
      status,
      schema,
      raw,
      at: nowIso(),
    };
    if (status !== "unavailable") contractValidation.observed += 1;
    if (status === "pass") contractValidation.passed += 1;
    if (status === "fail") contractValidation.failed += 1;
    if (status === "error") contractValidation.errors += 1;
    if (schema) contractValidation.schemas.add(schema);
    contractValidation.last = record;
    return record;
  }

  function wowContractValidationSnapshot() {
    const failed = contractValidation.failed + contractValidation.errors;
    return {
      verifier: "runtime backend AJV response validator",
      source: "X-OSL-WoW-Validation",
      status: failed > 0 ? "failed" : contractValidation.passed > 0 ? "passed" : "unavailable",
      observed: contractValidation.observed,
      passed: contractValidation.passed,
      failed: contractValidation.failed,
      errors: contractValidation.errors,
      schemas: Array.from(contractValidation.schemas),
      last: contractValidation.last ? { ...contractValidation.last } : null,
      standards_conformance: false,
    };
  }

  function emitApiRequest(record) {
    try {
      apiEvents.dispatchEvent(createCustomEvent("wow-api-request", { detail: record }));
    } catch (error) {
      /* telemetry must never break a request */
    }
  }

  async function getJson(url) {
    const started = nowMs();
    const sequence = ++requestSequence;
    let status = 0;
    let validation = null;
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      status = response.status;
      validation = recordWowContractValidation(url, response.headers.get("X-OSL-WoW-Validation"));
      if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
      const data = await response.json();
      emitApiRequest({
        id: sequence, method: "GET", url, path: displayPath(url), status,
        ok: true, ms: Math.round(nowMs() - started),
        schema: schemaLabelForUrl(url, "GET"), validation, at: nowIso(),
      });
      return data;
    } catch (error) {
      emitApiRequest({
        id: sequence, method: "GET", url, path: displayPath(url), status,
        ok: false, ms: Math.round(nowMs() - started),
        schema: schemaLabelForUrl(url, "GET"), validation, error: error.message, at: nowIso(),
      });
      throw error;
    }
  }

  async function postJson(url, body) {
    const started = nowMs();
    const sequence = ++requestSequence;
    let status = 0;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    status = response.status;
    const validation = recordWowContractValidation(url, response.headers.get("X-OSL-WoW-Validation"));
    const data = await response.json().catch(() => ({}));
    emitApiRequest({
      id: sequence, method: "POST", url, path: displayPath(url), status,
      ok: response.ok, ms: Math.round(nowMs() - started),
      schema: schemaLabelForUrl(url, "POST"), validation, at: nowIso(),
    });
    if (!response.ok) {
      const error = new Error(`POST ${url} -> ${response.status}`);
      error.body = data;
      throw error;
    }
    return data;
  }

  function rawFetch(url, options) {
    return fetchImpl(url, options);
  }

  function emitSyntheticApiRequest(record) {
    const detail = { id: ++requestSequence, at: nowIso(), ...record };
    apiEvents.dispatchEvent(createCustomEvent("wow-api-request", { detail }));
    return detail;
  }

  return {
    apiEvents,
    getJson,
    postJson,
    rawFetch,
    displayPath,
    schemaLabelForUrl,
    wowContractValidationSnapshot,
    emitSyntheticApiRequest,
  };
}

export const DEFAULT_LIVE_ADAPTER_TRANSPORT = createLiveAdapterTransport();
