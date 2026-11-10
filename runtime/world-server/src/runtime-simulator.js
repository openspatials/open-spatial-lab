'use strict';
class RuntimeSimulator
{
    constructor({ spatialResolve, updateSpatialNode, currentRevision })
    {
        this.spatialResolve = spatialResolve;
        this.updateSpatialNode = updateSpatialNode;
        this.currentRevision = currentRevision;
        this.current = null;
    }
    startSimulator(spec)
    {
        this.stopSimulator();
        const opts = Object.assign({ interval_ms : 1000, count : 120, graph : 1 }, spec || {});
        let resolveDone, tick = 0;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const run = { timer : null, log : [], done, opts };
        run.timer = setInterval(() => { if (this.step(run, tick + 1, resolveDone)) tick += 1; }, opts.interval_ms);
        this.current = run;
        return run;
    }
    find(opts)
    {
        const store = this.spatialResolve(String(opts.graph));
        if (!store) return null;
        if (Number.isInteger(opts.node_id)) return store.getNode(opts.node_id, { form : 'flat' }) ? opts.node_id : null;
        const hit = store.listNodes().find(n => n.label === opts.node_label);
        return hit ? hit.id : null;
    }
    step(run, tick, resolveDone)
    {
        const { opts, log } = run;
        const id = this.find(opts);
        if (id === null) return false;
        const angle = (tick * 15 * Math.PI) / 180;
        const c = Math.cos(angle);
        const sn = Math.sin(angle);
        const x = Number((0.5 * Math.sin(tick / 4)).toFixed(6));
        const temperature = Number((20 + 5 * Math.sin(tick / 10)).toFixed(2));
        const current = this.spatialResolve(String(opts.graph)).getNode(id, { form : 'flat' });
        const properties = Object.assign({}, current.properties || {}, { temperature : temperature });
        const body = { localTransform : [ c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, x, 0, 0, 1 ], properties : properties };
        const r = this.updateSpatialNode(String(opts.graph), id, body, { form : 'flat' });
        log.push({ tick : tick, node_id : id, revision : this.currentRevision().revision, time : this.currentRevision().time, temperature : temperature,
            localTransform : body.localTransform, changed : !!(r.ok && !r.unchanged) });
        if (tick >= opts.count) { this.stopSimulator(); resolveDone(log); }
        return true;
    }
    stopSimulator()
    {
        if (this.current && this.current.timer) clearInterval(this.current.timer);
        if (this.current) this.current.timer = null;
    }
    getSimulatorLog() { return this.current ? this.current.log.slice() : []; }
}
function createRuntimeSimulator(options)
{
    const clock = new RuntimeSimulator(options);
    return { startSimulator : clock.startSimulator.bind(clock),
        stopSimulator : clock.stopSimulator.bind(clock), getSimulatorLog : clock.getSimulatorLog.bind(clock) };
}
module.exports = { createRuntimeSimulator };
