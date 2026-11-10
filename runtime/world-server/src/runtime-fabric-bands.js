'use strict';
/** Deterministic distance bands, existing TTL overrides and explicitly nonconforming tileset projections. */
const { clone } = require('./runtime-projection-values');
const { fabricRegionBoundary } = require('./runtime-fabric-region');
const FABRIC_REGION_BAND_COUNT = 3; // equal rings inside the ROI
const FABRIC_REGION_BAND_LABELS = [ 'near', 'mid', 'far' ];
const FABRIC_REGION_BEYOND_LABEL = 'beyond_roi';
const FABRIC_REGION_BAND_TTLS_MS = { near : 20000, mid : 40000, far : 60000, beyond_roi : 90000 };
const FABRIC_REGION_SERVER_MAX_ENTITIES = 64;
const FABRIC_REGION_SERVER_MAX_BYTES = 65536;
const FABRIC_REGION_DEFAULT_MAX_ENTITIES = 24;
const FABRIC_REGION_DEFAULT_MIN_BYTES = 256;
const FABRIC_REGION_DEFAULT_MAX_BYTES = 16384;

function fabricBandTtlMs(bandLabel, LOCATION_ID)
{
    const base = FABRIC_REGION_BAND_TTLS_MS[bandLabel] || 60000;
    const raw = process.env.OSL_FABRIC_REGION_TTL_OVERRIDES;
    if (!raw) return base;
    try
    {
        const parsed = JSON.parse(raw);
        const forLocation = parsed && typeof parsed === 'object' ? parsed[LOCATION_ID] : null;
        const hit = forLocation && typeof forLocation === 'object' ? Number(forLocation[bandLabel]) : NaN;
        return Number.isFinite(hit) && hit >= 250 ? hit : base;
    }
    catch (e)
    {
        return base;
    }
}
function fabricRegionBands(scan, scope)
{
    const radius = scan.radius;
    const step = radius / FABRIC_REGION_BAND_COUNT;
    const bands = [];
    for (let i = 0; i < FABRIC_REGION_BAND_COUNT; i += 1)
    {
        bands.push({
            band_index : i,
            band_label : FABRIC_REGION_BAND_LABELS[i],
            range_m : [ Number((i * step).toFixed(3)), Number(((i + 1) * step).toFixed(3)) ],
            entities : [],
        });
    }
    if (scope === 'full')
    {
        bands.push({
            band_index : FABRIC_REGION_BAND_COUNT,
            band_label : FABRIC_REGION_BEYOND_LABEL,
            range_m : [ Number(radius.toFixed(3)), null ],
            entities : [],
        });
    }
    const sorted = scan.included.slice().sort(
        (a, b) => a.distance_from_anchor_m - b.distance_from_anchor_m
            || String(a.object_id).localeCompare(String(b.object_id)));
    for (const entry of sorted)
    {
        const idx = Math.min(FABRIC_REGION_BAND_COUNT - 1,
            Math.floor(entry.distance_from_anchor_m / step));
        bands[idx].entities.push(entry);
    }
    if (scope === 'full')
    {
        const beyondSorted = scan.beyond.slice().sort(
            (a, b) => a.distance_from_anchor_m - b.distance_from_anchor_m
                || String(a.object_id).localeCompare(String(b.object_id)));
        bands[FABRIC_REGION_BAND_COUNT].entities = beyondSorted;
    }
    return bands;
}
function getFabricRegionTilesetHypothesis(scan, LOCATION_ID, WORLD_ID, proof)
{
    const bands = fabricRegionBands(scan, 'full');
    const anchor = scan.anchor;
    const maxObserved = bands.reduce((acc, b) => {
        const last = b.entities.length ? b.entities[b.entities.length - 1] : null;
        return last ? Math.max(acc, last.distance_from_anchor_m) : acc;
    }, scan.radius);
    return clone(Object.assign({
        ok : true,
        location_id : LOCATION_ID,
        world_id : WORLD_ID,
        fabric_id : 'local-fabric-' + LOCATION_ID,
        hypothesis_artifact : true,
        three_d_tiles_shaped : true,
        three_d_tiles_conformance : false,
        purpose : 'runtime labeled hypothesis artifact — expresses the '
            + '/fabric/region distance-band chunk layout in an OGC-3D-Tiles-SHAPED '
            + 'structure (bounding volumes + coarse geometric error + ADD refinement) '
            + 'as a concrete input for future standards conversation. NOT a 3D Tiles '
            + 'tileset; no conformance is claimed or implied.',
        asset_shape : { version_shape : '1.1-shaped', tileset_shape_only : true },
        geometricError : Number((maxObserved * 2).toFixed(3)),
        root : {
            boundingVolume : { sphere : [ anchor[0], anchor[1], anchor[2], Number(maxObserved.toFixed(3)) ] },
            geometricError : Number(scan.radius.toFixed(3)),
            refine : 'ADD',
            children : bands.map(b => bandTile(b, scan, maxObserved, LOCATION_ID)),
        },
        proof_boundary : proof,
    }, fabricRegionBoundary(), { chunking_standard_conformance : false }));
}
function bandTile(b, scan, maxObserved, LOCATION_ID)
{
    const anchor = scan.anchor;
    const outer = b.range_m[1] != null ? b.range_m[1] : Number(maxObserved.toFixed(3));
    return {
        boundingVolume : { sphere : [ anchor[0], anchor[1], anchor[2], outer ] },
        geometricError : Number((outer / FABRIC_REGION_BAND_COUNT).toFixed(3)),
        content : {
            uri : '/fabric/region?anchor_portal_id='
                + encodeURIComponent(scan.portal.portal_id)
                + '&chunked=1&scope=full&cursor=' + b.band_index + ':0',
        },
        extensions : {
            osl_local_band : {
                band_index : b.band_index,
                band_label : b.band_label,
                range_m : b.range_m,
                entity_count : b.entities.length,
                ttl_ms : fabricBandTtlMs(b.band_label, LOCATION_ID),
            },
        },
    };
}

module.exports = { FABRIC_REGION_BAND_COUNT, FABRIC_REGION_BAND_LABELS, FABRIC_REGION_BEYOND_LABEL, FABRIC_REGION_BAND_TTLS_MS, FABRIC_REGION_SERVER_MAX_ENTITIES, FABRIC_REGION_SERVER_MAX_BYTES, FABRIC_REGION_DEFAULT_MAX_ENTITIES, FABRIC_REGION_DEFAULT_MIN_BYTES, FABRIC_REGION_DEFAULT_MAX_BYTES, fabricBandTtlMs, fabricRegionBands, getFabricRegionTilesetHypothesis };
