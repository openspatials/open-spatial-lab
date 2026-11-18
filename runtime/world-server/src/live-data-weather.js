'use strict';

/*
 * A stand-in weather source for roadmap A2's weather layer, on 127.0.0.1 only.
 *
 * It changes one node's `properties.temperature` in its own world, through the world's own runtime, at a
 * fixed interval: from a given list of values, or from a slow curve that crosses 0 °C again and again. No
 * outside data service is read. Each change is logged with the world's revision and time, the way the
 * iteration 3 simulator logs its changes.
 */

/** The default curve: degrees Celsius for tick 1, 2, ... crossing 0 every few ticks. */
function curve(tick)
{
    return Number((4 * Math.sin(tick / 2) + 0.5).toFixed(2));
}

/**
 * Start the source. spec: { node_id, graph = 1, interval_ms = 1000, values?: number[], count? }.
 * With `values`, it writes each once and ends; without, it writes the curve `count` times (no end when
 * count is not given). Returns { log, done, stop }.
 */
function startWeather(runtime, spec)
{
    const opts = Object.assign({ graph : 1, interval_ms : 1000 }, spec || {});
    const graph = String(opts.graph);
    const total = Array.isArray(opts.values) ? opts.values.length : (Number.isInteger(opts.count) ? opts.count : Infinity);
    const log = [];
    let tick = 0;
    let timer = null;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    function step()
    {
        const node = runtime.getSpatialNode(graph, opts.node_id, { form : 'flat' });
        if (!node) return;
        tick += 1;
        const temperature = Array.isArray(opts.values) ? opts.values[tick - 1] : curve(tick);
        const properties = Object.assign({}, node.properties || {}, { temperature : temperature });
        const r = runtime.updateSpatialNode(graph, opts.node_id, { properties : properties }, { form : 'flat' });
        const at = runtime.currentRevision();
        log.push({ tick : tick, node_id : opts.node_id, revision : at.revision, time : at.time, temperature : temperature, changed : !!(r && r.ok && !r.unchanged) });
        if (tick >= total) stop();
    }

    function stop()
    {
        if (timer) clearInterval(timer);
        timer = null;
        resolveDone(log);
    }

    timer = setInterval(step, opts.interval_ms);
    return { log, done, stop };
}

module.exports = { startWeather, curve };
