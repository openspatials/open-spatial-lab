// web/live-data-layers.mjs
//
// Roadmap A2: live data layers on one real place, where one layer reads another.
//
// A LAYER is a node in a world whose `properties` describe it as a JSON-LD node object, typed through
// iteration 3's context (wow-spec/context/wow.context.jsonld, served by every world at
// {base}wow/context.jsonld). Two layers share one place:
//
//   the weather layer   a node whose `temperature` a stand-in source on 127.0.0.1 changes over time
//                       (runtime/world-server/src/live-data-weather.js);
//   the game layer      a node in another world that holds the weather layer's data-point URL under
//                       `mirror.temperature`, so its world's server mirrors every weather value into the
//                       game node (runtime/world-server/src/mirrors.js, the rule of checks O6 and O6b),
//                       and a game object, a pond, that freezes below the layer's threshold.
//
// Each value is shown with its age, computed from the `time` of the change that set it; a value older
// than its layer's `osl:staleAfterSeconds` is marked stale.
//
// PURE: no DOM and no network, so the page, the A2 proof and the demo share it.

/** The real place both layers describe: a geo URI (RFC 5870), the lab's reference point. */
export const PLACE = "geo:47.7,-122.3";

/** JSON-LD keywords a layer description may use besides the context's terms. */
const KEYWORDS = new Set(["@context", "@type", "@id"]);

/** The weather layer's description, as its node's `properties`. */
export function weatherLayerProperties({ contextUrl, temperature, staleAfterSeconds = 3 }) {
  return {
    "@context": contextUrl,
    "@type": "osl:WeatherLayer",
    "osl:place": PLACE,
    "osl:unit": "Cel",
    "osl:source": "stand-in weather source on 127.0.0.1",
    "osl:staleAfterSeconds": staleAfterSeconds,
    temperature,
  };
}

/** The game layer's description: it reads the weather layer's value through `mirror`, and names its rule. */
export function gameLayerProperties({ contextUrl, weatherPoint, temperature, threshold = 0, staleAfterSeconds = 3 }) {
  return {
    "@context": contextUrl,
    "@type": "osl:GameLayer",
    "osl:place": PLACE,
    "osl:object": "pond",
    "osl:threshold": threshold,
    "osl:below": "frozen",
    "osl:above": "open",
    "osl:staleAfterSeconds": staleAfterSeconds,
    temperature,
    mirror: { temperature: weatherPoint },
  };
}

/** The game object's state for a temperature, by the game layer's own rule. */
export function reaction(game, temperature) {
  if (typeof temperature !== "number") return "unknown";
  return temperature < game["osl:threshold"] ? game["osl:below"] : game["osl:above"];
}

/** Seconds since an RFC 3339 time, or null. */
export function ageOf(time, now = Date.now()) {
  if (!time) return null;
  const at = Date.parse(time);
  return Number.isFinite(at) ? Math.max(0, (now - at) / 1000) : null;
}

/** True when a value set at `time` is older than its layer allows. */
export function isStale(time, staleAfterSeconds, now = Date.now()) {
  const age = ageOf(time, now);
  return age !== null && age > staleAfterSeconds;
}

export function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** The terms of a description's contexts. `contexts` maps a context URL to its fetched document. */
function termsOf(description, contexts, errors) {
  const terms = {};
  const list = [].concat(description["@context"] || []);
  if (!list.length) errors.push("no @context");
  for (const ctx of list) {
    const doc = typeof ctx === "string" ? contexts.get(ctx) : { "@context": ctx };
    if (!doc || typeof doc["@context"] !== "object") { errors.push(`context ${ctx} could not be read`); continue; }
    Object.assign(terms, doc["@context"]);
  }
  return terms;
}

/**
 * A term's IRI through a context, or null. A term the context defines expands to its definition; a
 * compact IRI expands only through a prefix the context defines; nothing else expands.
 */
export function expandTerm(terms, value, depth = 0) {
  if (typeof value !== "string" || depth > 8) return null;
  if (Object.prototype.hasOwnProperty.call(terms, value) && !value.startsWith("@")) {
    const def = terms[value];
    const id = typeof def === "string" ? def : def && def["@id"];
    if (typeof id !== "string") return null;
    const colon = id.indexOf(":");
    const prefix = colon > 0 ? id.slice(0, colon) : null;
    if (prefix && prefix !== value && Object.prototype.hasOwnProperty.call(terms, prefix)) return expandTerm(terms, id, depth + 1);
    return colon > 0 ? id : null;
  }
  const colon = value.indexOf(":");
  if (colon > 0) {
    const prefix = value.slice(0, colon);
    if (!Object.prototype.hasOwnProperty.call(terms, prefix)) return null;
    const base = expandTerm(terms, prefix, depth + 1);
    return base ? base + value.slice(colon + 1) : null;
  }
  return null;
}

/**
 * Validate a layer description against its JSON-LD context. The rule: it names a context; every key that
 * is not a JSON-LD keyword, and every `@type`, expands through that context to an IRI; and `mirror`, an
 * index container in the context, maps terms the context defines to data-point URLs (a URL with a JSON
 * Pointer fragment).
 */
export function validateDescription(description, contexts) {
  const errors = [];
  if (!description || typeof description !== "object") return { ok: false, errors: ["not an object"], expanded: {} };
  const terms = termsOf(description, contexts, errors);
  const expanded = {};
  for (const key of Object.keys(description)) {
    if (KEYWORDS.has(key)) continue;
    const iri = expandTerm(terms, key);
    if (!iri) errors.push(`term "${key}" is not defined by the context`);
    else expanded[key] = iri;
  }
  const types = [].concat(description["@type"] || []);
  if (!types.length) errors.push("no @type");
  for (const t of types) {
    const iri = expandTerm(terms, t);
    if (!iri) errors.push(`type "${t}" is not defined by the context`);
    else expanded["@type"] = [].concat(expanded["@type"] || [], iri);
  }
  if (description.mirror !== undefined) {
    const def = terms.mirror;
    if (!def || def["@container"] !== "@index") errors.push("the context does not make mirror an index container");
    if (!description.mirror || typeof description.mirror !== "object") errors.push("mirror is not an object");
    else for (const [term, url] of Object.entries(description.mirror)) {
      if (!expandTerm(terms, term)) errors.push(`mirror names "${term}", which the context does not define`);
      if (typeof url !== "string" || !/^https?:\/\/[^#]+#\//.test(url)) errors.push(`mirror.${term} is not a data-point URL`);
    }
  }
  return { ok: errors.length === 0, errors, expanded };
}
