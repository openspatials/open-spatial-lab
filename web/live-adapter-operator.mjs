// Explicit panel actions use the existing transport; route selection remains in LiveAdapter.
export async function fetchLiveApiEndpoint(transport, { base, portalId }, kind, id) {
  let url;
  let schema;
  switch (String(kind)) {
    case "world":
      url = `${base}/wow/world`;
      schema = "World";
      break;
    case "user":
      url = `${base}/wow/user/${encodeURIComponent(id != null && id !== "" ? id : 1)}`;
      schema = "User";
      break;
    case "view":
      url = `${base}/wow/view/${encodeURIComponent(id != null && id !== "" ? id : 1)}`;
      schema = "View";
      break;
    case "portal":
      url = `${base}/wow/portal/${encodeURIComponent(id != null && id !== "" ? id : portalId)}`;
      schema = "Portal";
      break;
    case "fabric":
      url = `${base}/fabric.json`;
      schema = "fabric manifest";
      break;
    default:
      return {
        ok: false,
        status: 0,
        url: null,
        schema: "unknown",
        json: { error: `unknown endpoint kind: ${kind}` },
      };
  }
  try {
    const json = await transport.getJson(url);
    return { ok: true, status: 200, url: transport.displayPath(url), schema, json };
  } catch (err) {
    // getJson attaches nothing structured on GET failure; re-fetch to surface
    // the live 404 body (the resource domain is real and demonstrable).
    let status = 0;
    let json = { error: err.message };
    try {
      const res = await transport.rawFetch(url, { headers: { Accept: "application/json" } });
      status = res.status;
      json = await res.json().catch(() => ({ error: `${res.status}` }));
    } catch (e2) {
      json = { error: e2.message };
    }
    return { ok: false, status, url: transport.displayPath(url), schema, json };
  }
}

export async function postPresenterExit(transport, url, portalId, readEndpointKey) {
  const packet = await transport.postJson(url, { portal_id: portalId });
  return {
    ok: true,
    status: 201,
    url: transport.displayPath(url),
    endpoint_key: readEndpointKey(),
    packet,
  };
}

export async function postPresenterArrival(transport, pkt, { deliverKey, deliverBase }, opts) {
  let before = null;
  try {
    const dbg = await transport.getJson(`${deliverBase}/debug/state`);
    before = dbg && dbg.session ? dbg.session.arrival_count : null;
  } catch (e) {
    /* best-effort */
  }

  const url = `${deliverBase}/portal/arrival`;
  try {
    const res = await transport.postJson(url, pkt);
    let after = null;
    try {
      const dbg = await transport.getJson(`${deliverBase}/debug/state`);
      after = dbg && dbg.session ? dbg.session.arrival_count : null;
    } catch (e) {
      /* best-effort */
    }
    return {
      ok: true,
      status: 201,
      url: transport.displayPath(url),
      delivered_to_endpoint: deliverKey,
      wrong_node: !!opts.toWrongNode,
      arrival_count_before: before,
      arrival_count_after: after,
      arrival_count_delta: before != null && after != null ? after - before : null,
      response: res,
    };
  } catch (err) {
    // The drift-guard 400 body IS the demonstrable "the API validates its
    // contract" payload — return it, do not throw.
    return {
      ok: false,
      status: err.body ? 400 : 0,
      url: transport.displayPath(url),
      delivered_to_endpoint: deliverKey,
      wrong_node: !!opts.toWrongNode,
      arrival_count_before: before,
      arrival_count_after: before,
      arrival_count_delta: 0,
      response: err.body || { error: err.message },
    };
  }
}
