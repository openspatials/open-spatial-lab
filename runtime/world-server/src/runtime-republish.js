'use strict';
const { clone } = require('./runtime-projection-values');
const { demoExtensionBoundary } = require('./runtime-scene-policy');
const { DEMO_REPUBLISH_RATE_DEFAULT_MS, DEMO_REPUBLISH_RATE_MIN_MS, DEMO_REPUBLISH_RATE_MAX_MS,
    DEMO_REPUBLISH_DRIFT_AMPLITUDE_M } = require('./runtime-republish-policy');
class RuntimeRepublish
{
    constructor({ readRate, writeRate, step, identity })
    {
        this.readRate = readRate;
        this.writeRate = writeRate;
        this.step = step;
        this.identity = identity;
        this.timer = null;
        this.tickCount = 0;
        writeRate(DEMO_REPUBLISH_RATE_DEFAULT_MS);
    }
    resetRate() { this.writeRate(DEMO_REPUBLISH_RATE_DEFAULT_MS); this.startRepublishTimer(); }
    stopRepublishTimer()
    {
        if (this.timer)
        {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    startRepublishTimer()
    {
        this.stopRepublishTimer();
        const rate = this.readRate();
        if (!(rate > 0)) return; // 0/off -> no timer
        this.timer = setInterval(() => this.step(++this.tickCount), rate);
        if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }

    setRepublishRate(rateMs)
    {
        const raw = Number(rateMs);
        let applied = 0;
        if (Number.isFinite(raw) && raw > 0)
        {
            applied = Math.max(DEMO_REPUBLISH_RATE_MIN_MS, Math.min(DEMO_REPUBLISH_RATE_MAX_MS, Math.round(raw)));
        }
        this.writeRate(applied);
        this.startRepublishTimer();
        return this.getRepublishRate();
    }

    getRepublishRate()
    {
        return clone(Object.assign({
            ok : true,
            location_id : this.identity.LOCATION_ID,
            world_id : this.identity.WORLD_ID,
            republish_rate_ms : this.readRate(),
            enabled : this.readRate() > 0,
            running : this.timer != null,
            republish_tick_count : this.tickCount,
            bounds_ms : { min : DEMO_REPUBLISH_RATE_MIN_MS, max : DEMO_REPUBLISH_RATE_MAX_MS },
            model : 'server_side_periodic_state_mutation',
            model_note : 'When > 0, the server applies a small bounded ambient drift to the '
                + 'hosted scene objects at this cadence and bumps the attach-point version. '
                + 'Clients PULL (re-read) the hosted point on their own reload cadence; the '
                + 'server does NOT push/stream this to clients. Boot/reset default to 100 ms; '
                + 'an explicit 0 disables ambient change and restores pre-runtime behavior.',
            drift_amplitude_m : DEMO_REPUBLISH_DRIFT_AMPLITUDE_M,
            reloadable_not_streaming : true,
        }, demoExtensionBoundary()));
    }
}
function createRuntimeRepublish(options)
{
    const clock = new RuntimeRepublish(options);
    return {
        stopRepublishTimer : clock.stopRepublishTimer.bind(clock),
        startRepublishTimer : clock.startRepublishTimer.bind(clock),
        setRepublishRate : clock.setRepublishRate.bind(clock),
        getRepublishRate : clock.getRepublishRate.bind(clock),
        resetRate : clock.resetRate.bind(clock),
    };
}

module.exports = { createRuntimeRepublish };
