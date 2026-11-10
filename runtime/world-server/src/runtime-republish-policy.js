'use strict';
const DEMO_REPUBLISH_RATE_DEFAULT_MS = 100;
const DEMO_REPUBLISH_RATE_MIN_MS = 100;   // fastest allowed cadence when > 0
const DEMO_REPUBLISH_RATE_MAX_MS = 60000; // slowest allowed cadence
const DEMO_REPUBLISH_DRIFT_AMPLITUDE_M = 0.35; // small bounded wander radius

module.exports = { DEMO_REPUBLISH_RATE_DEFAULT_MS, DEMO_REPUBLISH_RATE_MIN_MS, DEMO_REPUBLISH_RATE_MAX_MS, DEMO_REPUBLISH_DRIFT_AMPLITUDE_M };
