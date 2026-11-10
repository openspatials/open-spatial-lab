'use strict';
/** Budget normalization, ordered selection and continuation of one distance band per response. */
const { readNumber } = require('./runtime-projection-values');
const { FABRIC_REGION_SERVER_MAX_ENTITIES, FABRIC_REGION_SERVER_MAX_BYTES, FABRIC_REGION_DEFAULT_MAX_ENTITIES,
    FABRIC_REGION_DEFAULT_MIN_BYTES, FABRIC_REGION_DEFAULT_MAX_BYTES, fabricBandTtlMs, fabricRegionBands } = require('./runtime-fabric-bands');
function fabricRegionEntityBytes(entity)
{
    return Buffer.byteLength(JSON.stringify(entity), 'utf8');
}

function normalizeChunkOptions(opts)
{
    const options = opts || {};
    const scope = options.scope == null || options.scope === '' ? 'roi' : String(options.scope);
    if (scope !== 'roi' && scope !== 'full')
        throw new Error('invalid scope "' + scope + '" (roi|full)');
    const maxEntities = Math.max(1, Math.min(FABRIC_REGION_SERVER_MAX_ENTITIES,
        Math.floor(options.max_entities == null || options.max_entities === ''
            ? FABRIC_REGION_DEFAULT_MAX_ENTITIES
            : readNumber(options.max_entities, FABRIC_REGION_DEFAULT_MAX_ENTITIES))));
    const maxBytes = Math.max(FABRIC_REGION_DEFAULT_MIN_BYTES,
        Math.min(FABRIC_REGION_SERVER_MAX_BYTES,
            Math.floor(options.max_bytes == null || options.max_bytes === ''
                ? FABRIC_REGION_DEFAULT_MAX_BYTES
                : readNumber(options.max_bytes, FABRIC_REGION_DEFAULT_MAX_BYTES))));
    return { options, scope, maxEntities, maxBytes };
}

function chunkCursor(options, bands, scope)
{
    let bandIndex = 0;
    let offset = 0;
    let cursorProvided = false;
    if (options.cursor != null && options.cursor !== '')
    {
        cursorProvided = true;
        const match = /^(\d+):(\d+)$/.exec(String(options.cursor));
        if (!match)
            throw new Error('invalid cursor "' + options.cursor + '" (expected <band>:<offset>)');
        bandIndex = Number(match[1]);
        offset = Number(match[2]);
        if (bandIndex >= bands.length)
            throw new Error('invalid cursor band ' + bandIndex + ' (scope ' + scope + ' has ' + bands.length + ' bands)');
        const bandLen = bands[bandIndex].entities.length;
        if (offset !== 0 && offset >= bandLen)
            throw new Error('invalid cursor offset ' + offset + ' (band ' + bandIndex + ' has ' + bandLen + ' entities)');
    }
    if (!cursorProvided)
    {
        while (bandIndex < bands.length - 1 && bands[bandIndex].entities.length === 0)
            bandIndex += 1;
    }

    return { bandIndex, offset, cursorProvided };
}

function selectChunkEntities(bands, bandIndex, offset, maxEntities, maxBytes)
{
    const band = bands[bandIndex];
    const chunkEntities = [];
    let chunkBytes = 0;
    let truncationReason = null;
    let byteBudgetExceededBySingleEntity = false;
    for (let i = offset; i < band.entities.length; i += 1)
    {
        const entity = band.entities[i];
        const entityBytes = fabricRegionEntityBytes(entity);
        if (chunkEntities.length >= maxEntities)
        {
            truncationReason = 'entity_budget';
            break;
        }
        if (chunkEntities.length > 0 && chunkBytes + entityBytes > maxBytes)
        {
            truncationReason = 'byte_budget';
            break;
        }
        if (chunkEntities.length === 0 && entityBytes > maxBytes)
            byteBudgetExceededBySingleEntity = true;
        chunkEntities.push(entity);
        chunkBytes += entityBytes;
    }
    return { band, chunkEntities, chunkBytes, truncationReason, byteBudgetExceededBySingleEntity };
}

function chunkContinuation(selection, bands, bandIndex, offset)
{
    const nextOffset = offset + selection.chunkEntities.length;
    let truncationReason = selection.truncationReason;
    const band = selection.band;
    let continuation = null;
    if (truncationReason)
    {
        continuation = {
            cursor : bandIndex + ':' + nextOffset,
            next_band_index : bandIndex,
            next_band_label : band.band_label,
            remaining_entities_in_band : band.entities.length - nextOffset,
        };
    }
    else
    {
        let nextBand = bandIndex + 1;
        while (nextBand < bands.length && bands[nextBand].entities.length === 0)
            nextBand += 1;
        if (nextBand < bands.length)
        {
            truncationReason = 'band_boundary';
            continuation = {
                cursor : nextBand + ':0',
                next_band_index : nextBand,
                next_band_label : bands[nextBand].band_label,
                remaining_entities_in_band : bands[nextBand].entities.length,
            };
        }
    }
    return { continuation, truncationReason };
}

function prepareFabricChunk(scan, request)
{
    const { options, scope, maxEntities, maxBytes } = request;
    const bands = fabricRegionBands(scan, scope);
    const cursor = chunkCursor(options, bands, scope);
    const selected = selectChunkEntities(bands, cursor.bandIndex, cursor.offset, maxEntities, maxBytes);
    return { bands, ...cursor, ...selected,
        ...chunkContinuation(selected, bands, cursor.bandIndex, cursor.offset) };
}

function projectFabricChunk({ scan, request, selection, locationId : LOCATION_ID, worldId : WORLD_ID, version, proof })
{
    const { scope, maxEntities, maxBytes } = request;
    const { bands, bandIndex, offset, band, chunkEntities, chunkBytes, byteBudgetExceededBySingleEntity, continuation, truncationReason } = selection;
    const truncated = continuation !== null;
    const nowIso = new Date().toISOString();
    const ttlMs = fabricBandTtlMs(band.band_label, LOCATION_ID);
    const scopeEntities = scope === 'full'
        ? scan.included.length + scan.beyond.length
        : scan.included.length;
    const response = {
        ok : true,
        location_id : LOCATION_ID,
        world_id : WORLD_ID,
        fabric_id : 'local-fabric-' + LOCATION_ID,
        version : version,
        region : chunkRegion(scan, scope, bands, LOCATION_ID),
        chunk : chunkBody({ scan, scope, bandIndex, offset, band, chunkEntities, chunkBytes, byteBudgetExceededBySingleEntity, nowIso, ttlMs }),
        continuation : continuation,
        truncated : truncated,
        truncation_reason : truncated ? truncationReason : null,
        budget : {
            max_entities : maxEntities,
            max_bytes : maxBytes,
            server_max_entities : FABRIC_REGION_SERVER_MAX_ENTITIES,
            server_max_bytes : FABRIC_REGION_SERVER_MAX_BYTES,
        },
        totals : {
            fabric_entities : scan.included.length + scan.beyond.length,
            region_entities : scan.included.length,
            excluded_entities : scan.beyond.length,
            scope_entities : scopeEntities,
            truncated : truncated,
        },
        freshness : { captured_at : nowIso, ttl_ms : ttlMs },
        proof_boundary : proof,
    };
    return response;
}

function chunkRegion(scan, scope, bands, LOCATION_ID)
{
    return {
        type : 'portal_neighborhood_radius_chunked',
        anchor_portal_id : scan.portal.portal_id,
        center : scan.anchor.slice(),
        radius_m : scan.radius,
        requested_radius_m : scan.requestedRadius,
        radius_clamped : scan.radius !== scan.requestedRadius,
        scope : scope,
        bands : bands.map(b => ({
            band_index : b.band_index,
            band_label : b.band_label,
            range_m : b.range_m,
            entity_count : b.entities.length,
            ttl_ms : fabricBandTtlMs(b.band_label, LOCATION_ID),
        })),
    };
}
function chunkBody({ scan, scope, bandIndex, offset, band, chunkEntities, chunkBytes, byteBudgetExceededBySingleEntity, nowIso, ttlMs })
{
    return {
        chunk_id : scan.portal.portal_id + '#' + scope + '#' + bandIndex + ':' + offset,
        band_index : bandIndex,
        band_label : band.band_label,
        band_range_m : band.range_m,
        entities : chunkEntities,
        entity_count : chunkEntities.length,
        byte_size : chunkBytes,
        byte_size_rule : 'sum of per-entity UTF-8 JSON bytes (measured server-side at serialization)',
        ...(byteBudgetExceededBySingleEntity
            ? { byte_budget_exceeded_by_single_entity : true }
            : {}),
        freshness : {
            generated_at : nowIso,
            ttl_ms : ttlMs,
            expires_at : new Date(Date.now() + ttlMs).toISOString(),
        },
    };
}

module.exports = { normalizeChunkOptions, prepareFabricChunk, projectFabricChunk };
