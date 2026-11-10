'use strict';
/** Shared JSON-copy and numeric/vector conversion rules for runtime projections. */
function clone(value)
{
    return JSON.parse(JSON.stringify(value));
}

function readNumber(value, fallback)
{
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function fabricRound(value, digits)
{
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
}

function fabricVec3(value, fallback)
{
    const src = Array.isArray(value) ? value : fallback;
    return [
        Number(src && src[0]) || 0,
        Number(src && src[1]) || 0,
        Number(src && src[2]) || 0,
    ];
}

function fabricRoundVec3(value, digits)
{
    return fabricVec3(value, [ 0, 0, 0 ]).map(entry => fabricRound(entry, digits));
}

function fabricNormalizeVec3(value, fallback)
{
    const v = fabricVec3(value, fallback || [ 0, 0, 1 ]);
    const length = Math.hypot(v[0], v[1], v[2]);
    if (length <= 1e-6) return fabricVec3(fallback || [ 0, 0, 1 ], [ 0, 0, 1 ]);
    return v.map(entry => entry / length);
}

module.exports = { clone, readNumber, fabricRound, fabricVec3, fabricRoundVec3, fabricNormalizeVec3 };
