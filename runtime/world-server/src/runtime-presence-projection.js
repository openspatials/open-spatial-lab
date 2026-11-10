'use strict';
const { PRESENCE_TTL_DEFAULT_MS, PRESENCE_TTL_MIN_MS, PRESENCE_TTL_MAX_MS,
    PRESENCE_HEARTBEAT_HINT_MS, PRESENCE_DEPART_TOMBSTONE_MS } = require('./runtime-presence-policy');

function presenceString(value, fallback, max)
{
    const s = value == null ? '' : String(value);
    return (s || fallback || '').slice(0, max || 120);
}

function presencePosition(value)
{
    if (!Array.isArray(value) || value.length < 3) return null;
    const p = value.slice(0, 3).map(entry => Number(entry));
    return p.every(entry => Number.isFinite(entry))
        ? p.map(entry => Number(entry.toFixed(4)))
        : null;
}

function presenceEntrySummary(entry, nowMs)
{
    return {
        player_id : entry.player_id,
        client_id : entry.client_id,
        avatar_id : entry.avatar_id,
        continuity_id : entry.continuity_id,
        display_name : entry.display_name,
        position : entry.position ? entry.position.slice() : null,
        rotation_y : entry.rotation_y,
        registered_at : entry.registered_at,
        last_seen_at : entry.last_seen_at,
        ttl_ms : entry.ttl_ms,
        expires_in_ms : Math.max(0, entry.expires_at_ms - nowMs),
        heartbeat_count : entry.heartbeat_count,
        registered_via : entry.registered_via,
    };
}

function liveWowPresenceUsers(entries)
{
    return entries.map(entry => ({
        id : entry.wow_user_id,
        player_id : entry.player_id,
        display_name : entry.display_name,
        avatar_id : entry.avatar_id,
        endpoint : '/wow/user/' + entry.wow_user_id,
        source : 'presence-registry',
    }));
}

function wowUserEvent(type, entry, locationId, proofBoundary)
{
    const evt = {
        type : type,
        ts : new Date().toISOString(),
        user : {
            id : entry.wow_user_id,
            player_id : entry.player_id,
            display_name : entry.display_name,
            avatar_id : entry.avatar_id,
        },
        location_id : locationId,
        urls : [ 'wow/user/' + entry.wow_user_id, 'wow/world' ],
        presence_scope : 'server-side-ttl-registry (local occupancy truth)',
        proof_boundary : proofBoundary(),
    };
    if (type === 'user_left') evt.userId = entry.wow_user_id;
    return evt;
}

function registryProjection(count)
{
    return {
        registered_player_count : count,
        ttl_default_ms : PRESENCE_TTL_DEFAULT_MS,
        ttl_bounds_ms : { min : PRESENCE_TTL_MIN_MS, max : PRESENCE_TTL_MAX_MS },
        heartbeat_interval_hint_ms : PRESENCE_HEARTBEAT_HINT_MS,
        register_endpoint : '/fabric/presence/register',
        heartbeat_endpoint : '/fabric/presence/heartbeat',
        depart_endpoint : '/fabric/presence/depart',
        mutation_rule : 'registration/heartbeat/departure are explicit player '
            + 'session actions POSTed to the player\'s OWN active server; '
            + 'GET reads never mutate',
    };
}

function fabricPresenceSummary(players, enforcement, facts, nowMs)
{
    return {
        occupancy : {
            avatars : players.map(entry => presenceEntrySummary(entry, nowMs)),
            registered_player_count : players.length,
            arrival_count : facts.arrivalCount,
            live_subscriber_count : facts.subscriberCount,
            source : 'server-side-presence-registry',
        },
        departure_enforcement : {
            _claim : 'runtime: an explicit departure is final — a heartbeat '
                + 'already in flight cannot upsert a departed player back into this world',
            tombstone_ms : PRESENCE_DEPART_TOMBSTONE_MS,
            active_tombstones : enforcement.active_tombstones,
            resurrections_blocked : enforcement.resurrections_blocked,
        },
        hosted_avatar_identity : {
            avatar_id : facts.avatar.avatar_id,
            continuity_id : facts.avatar.continuity_id,
            display_name : facts.avatar.display_name,
            note : 'hosted world avatar identity record, not a registered player',
        },
        presence_scope : 'server-side per-location player registry '
            + ': occupancy.avatars lists the players explicitly '
            + 'registered with THIS location\'s server via register/heartbeat/depart, '
            + 'TTL-expired against ghosts; one presence truth shared with observer '
            + 'views through session.connected_clients',
        registry : registryProjection(players.length),
        captured_at : new Date().toISOString(),
        ttl_ms : 4000,
    };
}

function presenceEntry(input, previous, id, now, via)
{
    const playerId = presenceString(input.player_id, '', 120);
    const requestedTtl = Number(input.requested_ttl_ms);
    const ttl = Number.isFinite(requestedTtl) && requestedTtl > 0
        ? Math.max(PRESENCE_TTL_MIN_MS, Math.min(PRESENCE_TTL_MAX_MS, Math.round(requestedTtl)))
        : PRESENCE_TTL_DEFAULT_MS;
    const nowIso = new Date(now).toISOString();
    return {
        player_id : playerId, wow_user_id : id,
        client_id : presenceString(input.client_id, playerId, 120),
        avatar_id : presenceString(input.avatar_id, 'avatar-unknown', 80),
        continuity_id : presenceString(input.continuity_id, input.avatar_id || playerId, 80),
        display_name : presenceString(input.display_name, input.avatar_id || 'player', 80),
        position : presencePosition(input.position),
        rotation_y : Number.isFinite(Number(input.rotation_y)) ? Number(input.rotation_y) : null,
        registered_at : previous ? previous.registered_at : nowIso,
        registered_at_ms : previous ? previous.registered_at_ms : now,
        last_seen_at : nowIso, last_seen_ms : now, ttl_ms : ttl, expires_at_ms : now + ttl,
        heartbeat_count : previous ? previous.heartbeat_count : 0,
        registered_via : String(via || 'register'),
    };
}

module.exports = { presenceString, presencePosition, presenceEntrySummary, liveWowPresenceUsers, wowUserEvent, fabricPresenceSummary, presenceEntry };
