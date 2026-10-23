'use strict';

/*
 * Coupling by observation (iteration 3).
 *
 * A node may hold another world's data-point URL as a property value, under `properties.mirror`:
 *
 *   { "temperature": 20, "mirror": { "temperature": "{B}/wow/spatial/1/node/42#/properties/temperature" } }
 *
 * This world's server then observes that data point (web/wow-observe.mjs, with nobody present in
 * either world) and writes each value into its own node's `properties.temperature`. It writes only to
 * itself. A write that changes nothing is no change (no revision, no event), so two worlds that mirror
 * each other settle instead of looping.
 */

const path = require('path');
const { pathToFileURL } = require('url');

const OBSERVE = pathToFileURL(path.join(__dirname, '..', '..', '..', 'web', 'wow-observe.mjs')).href;

function createMirrors(runtime, options)
{
    options = options || {};
    let observer = null;
    let loading = null;
    let stopped = false;
    const watched = new Map(); // data-point URL -> [{ graphId, nodeId, term }]
    const known = new Set(); // graphId:nodeId:term:url already mirrored
    const stats = { writes : 0, changes : 0 };

    async function ensureObserver()
    {
        if (observer) return observer;
        if (!loading) loading = import(OBSERVE).then((mod) => {
            observer = mod.createObserver({
                token : options.token,
                onChange : (point) => apply(point),
            });
            return observer;
        });
        return loading;
    }

    function apply(point, only)
    {
        if (stopped || point.status !== 'ok') return;
        for (const target of watched.get(point.url) || [])
        {
            if (only && !only.has(keyOf(target, point.url))) continue;
            const node = runtime.getSpatialNode(String(target.graphId), target.nodeId, { form : 'flat' });
            if (!node) continue;
            const properties = Object.assign({}, node.properties || {});
            properties[target.term] = point.value;
            stats.writes += 1;
            const r = runtime.updateSpatialNode(String(target.graphId), target.nodeId, { properties : properties }, { form : 'flat' });
            if (r.ok && !r.unchanged) stats.changes += 1;
        }
    }

    /** Find every node that mirrors a data point, and observe the ones not yet observed. */
    async function refresh()
    {
        if (stopped) return;
        const found = new Map();
        for (const { graphId, node } of runtime.listSpatialNodes())
        {
            const mirror = node.properties && node.properties.mirror;
            if (!mirror || typeof mirror !== 'object') continue;
            for (const [term, url] of Object.entries(mirror))
            {
                if (typeof url !== 'string' || !/^https?:/.test(url)) continue;
                if (!found.has(url)) found.set(url, []);
                found.get(url).push({ graphId, nodeId : node.id, term });
            }
        }
        watched.clear();
        for (const [url, targets] of found) watched.set(url, targets);
        // A node that has just started to mirror gets the current value once. Later values come only
        // from the source's events, so a node's own change is never undone by a stale copy.
        const fresh = new Set();
        for (const [url, targets] of found) for (const t of targets) { const key = keyOf(t, url); if (!known.has(key)) fresh.add(key); }
        known.clear();
        for (const [url, targets] of found) for (const t of targets) known.add(keyOf(t, url));
        if (!found.size) return;
        const obs = await ensureObserver();
        for (const url of found.keys())
        {
            if (obs.points.has(url)) apply(obs.points.get(url), fresh);
            else obs.watch(url).then((point) => apply(point)).catch(() => {});
        }
    }

    function keyOf(target, url)
    {
        return target.graphId + ':' + target.nodeId + ':' + target.term + ':' + url;
    }

    let pending = null;
    const unsubscribe = runtime.subscribeEvents((evt) => {
        if (!/^node_/.test(evt.type) || pending) return;
        pending = setTimeout(() => { pending = null; refresh().catch(() => {}); }, 0);
    });
    refresh().catch(() => {});

    return {
        stats,
        refresh,
        stop()
        {
            stopped = true;
            unsubscribe();
            if (pending) clearTimeout(pending);
            if (observer) observer.close();
        },
    };
}

module.exports = { createMirrors };
