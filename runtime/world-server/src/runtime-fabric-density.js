'use strict';
/** Opt-in deterministic density fixture; default scene content is unchanged when unset. */
const FABRIC_DENSITY_FIXTURE_PALETTE = [
    '#2bd4ff', '#6ee7a8', '#8a7dff', '#ff8c42', '#ffd166', '#c65ccd', '#9fb0d0', '#42d68a',
];
function densityFixtureFor(locationId)
{
    const raw = process.env.OSL_FABRIC_DENSITY_FIXTURE;
    if (!raw) return null;
    try
    {
        const parsed = JSON.parse(raw);
        const hit = parsed && typeof parsed === 'object' ? parsed[locationId] : null;
        return hit && typeof hit === 'object' ? hit : null;
    }
    catch (e)
    {
        return null;
    }
}
function densityFixtureSceneObjects(locationId, portals)
{
    const fixture = densityFixtureFor(locationId);
    if (!fixture) return [];
    const firstPortal = Array.isArray(portals) && portals.length ? portals[0] : null;
    const anchor = firstPortal && firstPortal.trigger
        && Array.isArray(firstPortal.trigger.position)
        ? firstPortal.trigger.position
        : [ 0, 0, 0 ];
    const quotas = Array.isArray(fixture.band_quotas) && fixture.band_quotas.length
        ? fixture.band_quotas.map(n => Math.max(0, Math.floor(Number(n) || 0)))
        : [ 15, 12, 12, 14 ];
    const roi = Number(fixture.roi_radius_m) > 0 ? Number(fixture.roi_radius_m) : 5.0;
    const beyondMax = Number(fixture.max_radius_m) > 0 ? Number(fixture.max_radius_m) : 9.0;
    const ranges = [
        [ 0.7, (roi / 3) * 0.94 ],
        [ (roi / 3) * 1.04, ((2 * roi) / 3) * 0.96 ],
        [ ((2 * roi) / 3) * 1.03, roi * 0.96 ],
        [ roi * 1.08, beyondMax ],
    ];
    const GOLDEN_ANGLE = 2.399963229728653;
    const objects = [];
    let serial = 0;
    quotas.forEach((count, band) => {
        const range = ranges[band] || ranges[ranges.length - 1];
        for (let j = 0; j < count; j += 1)
        {
            const frac = count <= 1 ? 0.5 : j / (count - 1);
            const r = range[0] + (range[1] - range[0]) * (0.06 + 0.88 * frac);
            const angle = GOLDEN_ANGLE * serial;
            objects.push(densityEntity(locationId, serial, anchor, r, angle));
            serial += 1;
        }
    });
    return objects;
}
function densityEntity(locationId, serial, anchor, r, angle)
{
    return {
        object_id : 'fixture-' + locationId + '-' + String(serial).padStart(3, '0'),
        shape : serial % 2 === 0 ? 'box' : 'sphere',
        size_m : 0.24,
        color : FABRIC_DENSITY_FIXTURE_PALETTE[serial % FABRIC_DENSITY_FIXTURE_PALETTE.length],
        position : [
            Number((anchor[0] + r * Math.cos(angle)).toFixed(3)),
            0.12,
            Number((anchor[2] + r * Math.sin(angle)).toFixed(3)),
        ],
        fixture : true,
        synthetic_density_fixture : true,
    };
}

module.exports = { densityFixtureSceneObjects };
